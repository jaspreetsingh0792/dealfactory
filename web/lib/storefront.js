// Preserve links to the personal shopping tools from earlier releases.
const advisorSections = new Set(["#setup", "#ai", "#assistant", "#about", "#connect", "#results", "#gmail", "#need-form"]);
if (location.pathname === "/" && advisorSections.has(location.hash)) {
  location.replace("/advisor/" + location.search + location.hash);
}
const grid = document.querySelector("#offer-grid");
if (grid) {
  const cards = [...grid.children];
  const sort = document.querySelector("#offer-sort");
  const filters = [...document.querySelectorAll("[data-filter]")];
  const protocols = [...document.querySelectorAll("[data-protocol]")];
  const feedback = document.querySelector("#filter-feedback");
  let retailer = "";
  let protocol = "";
  function fits(card) {
    return (card.dataset.fits || "").split(",").map(part => part.trim()).filter(Boolean);
  }
  function amount(card) {
    if (sort.value === "total" && card.dataset.total) return Number(card.dataset.total);
    return Number(card.dataset.price);
  }
  function update() {
    const ordered = [...cards].sort((a, b) => {
      if (sort.value === "name") return a.dataset.name.localeCompare(b.dataset.name);
      const difference = amount(a) - amount(b);
      return sort.value === "desc" ? -difference : difference;
    });
    let shown = 0;
    for (const card of ordered) {
      const shopMatch = !retailer || card.dataset.shop === retailer;
      const fitMatch = !protocol || fits(card).includes(protocol);
      card.hidden = !(shopMatch && fitMatch);
      if (!card.hidden) shown++;
      grid.append(card);
    }
    feedback.textContent = shown + (shown === 1 ? " offer" : " offers") + (retailer ? " from " + retailer : "") + (protocol ? " for " + protocol : "");
  }
  sort.addEventListener("change", update);
  for (const button of filters) button.addEventListener("click", () => {
    retailer = button.dataset.filter;
    for (const item of filters) item.setAttribute("aria-pressed", String(item === button));
    update();
  });
  for (const button of protocols) button.addEventListener("click", () => {
    protocol = button.dataset.protocol;
    for (const item of protocols) item.setAttribute("aria-pressed", String(item === button));
    update();
  });
  for (const img of grid.querySelectorAll("img")) {
    const load = () => { if (img.naturalWidth > 0) img.parentElement.classList.add("loaded"); };
    img.addEventListener("load", load);
    img.addEventListener("error", () => { img.hidden = true; });
    if (img.complete) {
      load();
      if (!img.naturalWidth) img.hidden = true;
    }
  }
}
