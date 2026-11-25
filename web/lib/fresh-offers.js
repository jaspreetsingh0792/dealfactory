const offers = document.querySelector("[data-offers-checked]");
if (offers) {
  const age = Date.now() - Date.parse(offers.dataset.offersChecked);
  if (age >= 0 && age < 36 * 60 * 60 * 1000) {
    offers.hidden = false;
    document.getElementById("unverified-offers").hidden = true;
  }
}
