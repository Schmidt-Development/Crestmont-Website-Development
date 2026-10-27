// Runs synchronously in <head> (the CSP forbids inline scripts): marks the document as script-capable before
// first paint so progressive-enhancement styles (off-canvas navigation, the hero engraving) never flash.
document.documentElement.classList.add("js");
