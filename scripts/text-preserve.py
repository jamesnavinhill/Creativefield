"""Keep text: put the clean print from a video's start picture back onto every frame.

Video models garble small lettering already when they encode the start picture (frame 0 differs from the picture
there, see Pad). This keeps the picture's lettering instead, tracked onto the moving surface.

  python text-preserve.py apply <clip> <picture> <out.mp4> <boxes>  -> {"frames":..., "boxes": [...]}

Boxes are fractions of frame 0 (0..1), `x0,y0,x1,y1;x0,y0,x1,y1`: the person marks the lettering (automatic finding
was tried and marked foliage and light instead, Pad DOC-1343). OpenCV only, CPU, no downloads.
Per box: align the picture to frame 0 (ECC homography), track the area to every frame (Lucas-Kanade with a
forward-backward check, RANSAC homography), bend the patch with the cloth (DIS flow on images blurred past the
letter size), carry the frame's light over (low-frequency ratio), composite inside a feathered mask.
"""
import json, sys, time
import cv2, numpy as np


def read_frames(path):
    cap, frames = cv2.VideoCapture(path), []
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    if not frames:
        raise SystemExit(json.dumps({"error": "The video could not be read."}))
    return frames, fps


gray = lambda im: cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
blur = lambda im, s: cv2.GaussianBlur(im, (0, 0), s)


def picture_at_clip_size(picture, frame):
    H, W = frame.shape[:2]
    ref = cv2.imread(picture)
    if ref is None:
        raise SystemExit(json.dumps({"error": "The start picture could not be read."}))
    # Same aspect: plain resize. Otherwise the model got a centre crop of the picture.
    rh, rw = ref.shape[:2]
    if abs(rw / rh - W / H) > 0.01:
        if rw / rh > W / H:
            nw = int(rh * W / H); x = (rw - nw) // 2; ref = ref[:, x:x + nw]
        else:
            nh = int(rw * H / W); y = (rh - nh) // 2; ref = ref[y:y + nh]
    return cv2.resize(ref, (W, H), interpolation=cv2.INTER_AREA)


def align(ref, frame, box=None, pad=34):
    """Homography from picture to frame 0, on the area around `box` (or the whole frame)."""
    H, W = frame.shape[:2]
    x0, y0, x1, y1 = (0, 0, W, H) if box is None else (max(0, box[0] - pad), max(0, box[1] - pad), min(W, box[2] + pad), min(H, box[3] + pad))
    a = blur(gray(ref)[y0:y1, x0:x1].astype(np.float32), 2.0)
    b = blur(gray(frame)[y0:y1, x0:x1].astype(np.float32), 2.0)
    warp = np.eye(3, dtype=np.float32)
    try:
        _, warp = cv2.findTransformECC(b, a, warp, cv2.MOTION_HOMOGRAPHY, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), None, 5)
    except cv2.error:
        pass
    T = np.array([[1, 0, x0], [0, 1, y0], [0, 0, 1]], np.float32)
    return T @ np.linalg.inv(warp) @ np.linalg.inv(T)


def apply(clip, picture, out_path, boxes):
    t_start = time.time()
    frames, fps = read_frames(clip)
    H, W = frames[0].shape[:2]
    ref = picture_at_clip_size(picture, frames[0])
    result = [f.copy() for f in frames]
    gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    lk = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    report = []
    for fx0, fy0, fx1, fy1 in boxes:
        bx0, by0, bx1, by1 = int(round(fx0 * W)), int(round(fy0 * H)), int(round(fx1 * W)), int(round(fy1 * H))
        if bx1 - bx0 < 6 or by1 - by0 < 4:
            report.append({"box": [bx0, by0, bx1, by1], "skipped": "frame too small"}); continue
        pad = max(24, int(0.45 * max(bx1 - bx0, by1 - by0)))
        rx0, ry0, rx1, ry1 = max(0, bx0 - pad), max(0, by0 - pad), min(W, bx1 + pad), min(H, by1 + pad)
        ref_to_0 = align(ref, frames[0], (bx0, by0, bx1, by1), pad)
        mask0 = np.zeros((H, W), np.uint8); mask0[ry0:ry1, rx0:rx1] = 255
        pts = cv2.goodFeaturesToTrack(gray(frames[0]), 220, 0.01, 4, mask=mask0)
        if pts is None or len(pts) < 8:
            report.append({"box": [bx0, by0, bx1, by1], "skipped": "too little texture to follow"}); continue
        homs, prev_g, prev_pts, base_pts, lost_track = [np.eye(3)], gray(frames[0]), pts.copy(), pts.copy(), 0
        for f in frames[1:]:
            g = gray(f)
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev_g, g, prev_pts, None, **lk)
            back, st2, _ = cv2.calcOpticalFlowPyrLK(g, prev_g, nxt, None, **lk)
            good = (st.ravel() == 1) & (st2.ravel() == 1) & (np.linalg.norm((back - prev_pts).reshape(-1, 2), axis=1) < 0.8)
            Hm = homs[-1]
            if good.sum() >= 12:
                found, _ = cv2.findHomography(base_pts[good], nxt[good], cv2.RANSAC, 2.0)
                if found is not None:
                    Hm = found
            else:
                lost_track += 1
            homs.append(Hm)
            prev_g, prev_pts, base_pts = g, nxt[good].reshape(-1, 1, 2), base_pts[good].reshape(-1, 1, 2)
            if len(prev_pts) < 40:
                m = np.zeros((H, W), np.uint8)
                poly = cv2.perspectiveTransform(np.float32([[[rx0, ry0]], [[rx1, ry0]], [[rx1, ry1]], [[rx0, ry1]]]), Hm).astype(np.int32)
                cv2.fillPoly(m, [poly.reshape(-1, 2)], 255)
                fresh = cv2.goodFeaturesToTrack(g, 220, 0.01, 4, mask=m)
                if fresh is not None:
                    prev_pts = fresh; base_pts = cv2.perspectiveTransform(fresh, np.linalg.inv(Hm))
        pm = np.zeros((H, W), np.float32); cv2.rectangle(pm, (bx0, by0), (bx1, by1), 1.0, -1)
        pm = blur(cv2.warpPerspective(pm, np.linalg.inv(ref_to_0), (W, H)), 2.5)
        before, after = [], []
        corners = np.float32([[[rx0, ry0]], [[rx1, ry0]], [[rx1, ry1]], [[rx0, ry1]]])
        bw, bh = bx1 - bx0, by1 - by0
        to_box = np.array([[1, 0, -bx0], [0, 1, -by0], [0, 0, 1]], np.float64)
        for t in range(len(frames)):
            f = result[t]
            M = homs[t] @ ref_to_0
            # Only the area around the print in this frame is worked on: the tracked padded box, plus a margin for
            # the cloth flow. Every step below is the same as on the whole frame, translated into that crop.
            poly = cv2.perspectiveTransform(corners, homs[t]).reshape(-1, 2)
            margin = 16
            cx0, cy0 = max(0, int(poly[:, 0].min()) - margin), max(0, int(poly[:, 1].min()) - margin)
            cx1, cy1 = min(W, int(np.ceil(poly[:, 0].max())) + margin), min(H, int(np.ceil(poly[:, 1].max())) + margin)
            if cx1 - cx0 < 8 or cy1 - cy0 < 8:
                before.append(np.zeros((bh, bw, 3), np.float32)); after.append(np.zeros((bh, bw, 3), np.float32)); continue
            cw, ch = cx1 - cx0, cy1 - cy0
            Mc = np.array([[1, 0, -cx0], [0, 1, -cy0], [0, 0, 1]], np.float64) @ M
            crop = f[cy0:cy1, cx0:cx1]
            wref = cv2.warpPerspective(ref, Mc, (cw, ch), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
            wmask = cv2.warpPerspective(pm, Mc, (cw, ch))
            inv = dis.calc(blur(gray(crop), 4.0), blur(gray(wref), 4.0), None) * (wmask > 0.01)[..., None]
            lx, ly = gx[:ch, :cw], gy[:ch, :cw]
            pulled = cv2.remap(wref, lx + inv[..., 0], ly + inv[..., 1], cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
            pmask = cv2.remap(wmask, lx + inv[..., 0], ly + inv[..., 1], cv2.INTER_LINEAR)
            lf, lr = blur(crop.astype(np.float32), 6.0), blur(pulled.astype(np.float32), 6.0)
            lit = np.clip(pulled.astype(np.float32) * np.clip(lf / np.maximum(lr, 1.0), 0.5, 2.0), 0, 255)
            comp = f.copy()
            comp[cy0:cy1, cx0:cx1] = (crop.astype(np.float32) * (1 - pmask[..., None]) + lit * pmask[..., None]).astype(np.uint8)
            back_box = to_box @ np.linalg.inv(homs[t])
            before.append(cv2.warpPerspective(frames[t], back_box, (bw, bh)).astype(np.float32))
            after.append(cv2.warpPerspective(comp, back_box, (bw, bh)).astype(np.float32))
            result[t] = comp
        step = lambda acc: float(np.mean([np.abs(acc[i] - acc[i - 1]).mean() for i in range(1, len(acc))])) if len(acc) > 1 else 0.0
        report.append({"box": [bx0, by0, bx1, by1], "change_before": round(step(before), 2), "change_after": round(step(after), 2), "frames_without_track": lost_track})
    out = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))
    for f in result:
        out.write(f)
    out.release()
    return {"frames": len(frames), "size": [W, H], "seconds": round(time.time() - t_start, 1), "boxes": report}


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "apply":
        boxes = [[min(1.0, max(0.0, float(v))) for v in part.split(",")[:4]] for part in sys.argv[5].split(";") if part.strip()]
        print(json.dumps(apply(sys.argv[2], sys.argv[3], sys.argv[4], boxes)))
    else:
        raise SystemExit(json.dumps({"error": "mode is apply"}))
