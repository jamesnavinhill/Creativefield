/* CreativeField adaptation of the embedded H3 Editor (inserted by scripts/install-h3-editor.ps1; the editor's own files
   stay unchanged otherwise). Only when CreativeField embeds the editor (?cf_project=...): one quiet top bar.
   - The project shows its CreativeField name (?cf_name=) instead of the folder name cf-<id>.
   - Render all drafts, Shortcuts and CreativeField's Analyze clip / Open in new tab live in the project menu (...).
     The hidden buttons stay in the page, so the editor's own handlers still run when a menu item clicks them.
   - The CSS beside it hides New project and Close, and the checks chip while there is nothing to check.
   - Menu entries (project menu, Generate) show their title; the description is the hover tooltip. */
(() => {
  const params = new URLSearchParams(location.search);
  if (!params.get("cf_project")) return;
  document.documentElement.dataset.cfEmbed = "1";
  const tell = type => parent.postMessage({type}, location.origin);
  const ready = () => {
    const name = params.get("cf_name"), label = document.getElementById("projectName");
    if (name && label) {
      const keep = () => { if (label.textContent !== name) label.textContent = name; };
      keep();
      new MutationObserver(keep).observe(label, {childList: true, characterData: true, subtree: true});
    }
    const menu = document.getElementById("projectMenu"), more = document.getElementById("projectMore");
    if (!menu || menu.querySelector("[data-cf-item]")) return;
    if (more) { more.setAttribute("aria-label", "More"); more.title = "More: render, shortcuts, analyze, rename, duplicate"; }
    const item = (title, text, act) => {
      const button = document.createElement("button");
      button.type = "button"; button.setAttribute("role", "menuitem"); button.dataset.cfItem = "1";
      const b = document.createElement("b"), span = document.createElement("span");
      b.textContent = title; span.textContent = text; button.append(b, span);
      button.addEventListener("click", () => { try { menu.hidePopover(); } catch { /* already closed */ } act(); });
      return button;
    };
    const click = id => () => document.getElementById(id)?.click();
    const first = menu.firstElementChild;
    for (const button of [
      item("Render all drafts", "Render every clip that is still a draft", click("renderAll")),
      item("Analyze clip", "Measure a clip's camera and add a grey-block previs of it", () => tell("creativefield:analyze")),
      item("Shortcuts", "Every key this editor knows", click("shortcuts")),
      item("Open in new tab", "This editor on a page of its own", () => tell("creativefield:newtab")),
    ]) menu.insertBefore(button, first);
    const line = document.createElement("hr"); line.dataset.cfItem = "1"; menu.insertBefore(line, first);
    // Menus show titles only; each entry's description becomes its hover tooltip (the CSS hides the line itself).
    for (const id of ["projectMenu", "generateMenu"])
      for (const button of document.querySelectorAll(`#${id} > button`)) {
        const text = button.querySelector(":scope > span")?.textContent?.trim();
        if (text && !button.title) button.title = text;
      }
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", ready); else ready();
})();
