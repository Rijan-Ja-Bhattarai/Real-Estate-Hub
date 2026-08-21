const siteHeader = document.querySelector("[data-header]");
const menuButton = document.querySelector("[data-menu-button]");
const mobileMenu = document.querySelector("[data-mobile-menu]");

try {
  const saved = JSON.parse(localStorage.getItem("nei-saved") || "[]");
  const savedCount = Array.isArray(saved) ? saved.length : 0;
  document.querySelectorAll("[data-shared-saved-count]").forEach((node) => { node.textContent = String(savedCount); });
} catch {
  document.querySelectorAll("[data-shared-saved-count]").forEach((node) => { node.textContent = "0"; });
}

if (siteHeader) {
  const updateHeader = () => siteHeader.classList.toggle("is-scrolled", window.scrollY > 20);
  updateHeader();
  window.addEventListener("scroll", updateHeader, { passive: true });
}

if (menuButton && mobileMenu) {
  const menuBackgroundNodes = document.querySelectorAll(
    "main, .site-footer, .site-header > .brand, .site-header > .desktop-nav, .site-header .saved-button, .site-header .feed-state",
  );

  const setMenuBackgroundInert = (inert) => {
    menuBackgroundNodes.forEach((node) => { node.inert = inert; });
  };

  const closeMenu = ({ restoreFocus = false } = {}) => {
    mobileMenu.classList.remove("is-open");
    mobileMenu.setAttribute("aria-hidden", "true");
    mobileMenu.inert = true;
    setMenuBackgroundInert(false);
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Open menu");
    document.body.classList.remove("menu-open");
    if (restoreFocus) menuButton.focus();
  };

  menuButton.addEventListener("click", () => {
    if (menuButton.getAttribute("aria-expanded") === "true") {
      closeMenu();
      return;
    }
    mobileMenu.classList.add("is-open");
    mobileMenu.setAttribute("aria-hidden", "false");
    mobileMenu.inert = false;
    setMenuBackgroundInert(true);
    menuButton.setAttribute("aria-expanded", "true");
    menuButton.setAttribute("aria-label", "Close menu");
    document.body.classList.add("menu-open");
    mobileMenu.querySelector("a, button")?.focus();
  });

  mobileMenu.querySelectorAll("a, [data-menu-close]").forEach((control) => {
    control.addEventListener("click", () => closeMenu());
  });
  document.addEventListener("nei:close-menu", () => closeMenu());
  window.addEventListener("resize", () => {
    if (window.innerWidth > 820) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobileMenu.classList.contains("is-open")) closeMenu({ restoreFocus: true });
    if (event.key !== "Tab" || !mobileMenu.classList.contains("is-open")) return;
    const focusable = [menuButton, ...mobileMenu.querySelectorAll("a, button")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
