// Preserve links to the personal shopping tools from earlier releases.
const advisorSections = new Set(["#setup", "#ai", "#assistant", "#about", "#connect", "#results", "#gmail", "#need-form"]);
if (location.pathname === "/" && advisorSections.has(location.hash)) {
  location.replace("/advisor.html" + location.search + location.hash);
}
const grid = document.querySelector("#offer-grid");
if (grid) {
  const cards = [...grid.children];
  const sort = document.querySelector("#offer-sort");
  const filters = [...document.querySelectorAll("[data-filter]")];
  const feedback = document.querySelector("#filter-feedback");
  let retailer = "";
  function update() {
    const ordered = [...cards].sort((a, b) => {
      if (sort.value === "name") return a.dataset.name.localeCompare(b.dataset.name);
      const difference = Number(a.dataset.price) - Number(b.dataset.price);
      return sort.value === "desc" ? -difference : difference;
    });
    let shown = 0;
    for (const card of ordered) {
      card.hidden = !!retailer && card.dataset.shop !== retailer;
      if (!card.hidden) shown++;
      grid.append(card);
    }
    feedback.textContent = shown + (shown === 1 ? " offer" : " offers") + (retailer ? " from " + retailer : "");
  }
  sort.addEventListener("change", update);
  for (const button of filters) button.addEventListener("click", () => {
    retailer = button.dataset.filter;
    for (const item of filters) item.setAttribute("aria-pressed", String(item === button));
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
