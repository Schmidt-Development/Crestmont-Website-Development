// Progressive enhancement for the contact form. Without JavaScript the form posts to /api/contact directly.
// The endpoint is UNCONFIGURED until a mail provider is connected: it answers 503 and this script tells the visitor
// to use the email/phone shown on the page. Never claim a message was sent unless the endpoint says ok.
(function () {
  const form = document.querySelector("[data-contact-form]");
  if (!form) return;
  const status = form.querySelector("[data-contact-status]");
  const say = (text, state) => { if (status) { status.textContent = text; status.dataset.state = state; } };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    say("Sending…", "pending");
    try {
      const res = await fetch(form.action, { method: "POST", body: new FormData(form), headers: { accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) { form.reset(); say("Thank you. Your message was sent.", "ok"); return; }
      if (body.configured === false) { say(body.error || "The contact form is not connected yet. Please email or call us.", "error"); return; }
      if (body.errors) { say(Object.values(body.errors).join(" "), "error"); return; }
      say("Something went wrong. Please email or call us instead.", "error");
    } catch {
      say("Something went wrong. Please email or call us instead.", "error");
    }
  });
})();
