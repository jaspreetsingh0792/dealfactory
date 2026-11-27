const offers = document.querySelector("[data-offers-checked]");
if (offers) {
  const age = Date.now() - Date.parse(offers.dataset.offersChecked);
  const fresh = age >= 0 && age < 36 * 60 * 60 * 1000;
  const unverified = document.getElementById("unverified-offers");
  if (!fresh) {
    offers.hidden = true;
    if (unverified) unverified.hidden = false;
  }
}
