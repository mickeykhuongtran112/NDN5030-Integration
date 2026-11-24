document.documentElement.classList.add("js");
const sidebar = document.querySelector(".sidebar");
const menu = document.querySelector(".menu");
const field = document.querySelector("#search");
const results = document.querySelector(".results");
const nav = sidebar.querySelector("nav");
const strings = window.docStrings;
for (const link of document.querySelectorAll("[data-language-link]")) {
  const page = link.getAttribute("href");
  link.addEventListener("click", () => {
    link.setAttribute("href", page + location.hash);
  });
}
function showMenu(open) {
  sidebar.classList.toggle("open", open);
  menu.setAttribute("aria-expanded", String(open));
}
menu.addEventListener("click", () => showMenu(!sidebar.classList.contains("open")));
document.addEventListener("click", e => {
  if (!sidebar.contains(e.target) && !menu.contains(e.target)) showMenu(false);
});
function normalize(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replaceAll("đ", "d");
}
function search() {
  const query = normalize(field.value.trim());
  results.replaceChildren();
  results.hidden = !query;
  nav.hidden = Boolean(query);
  if (!query) return;
  const words = query.split(/\s+/);
  const matches = window.docIndex.map((item, i, sections) => {
    const name = normalize(item.title), body = normalize(item.body);
    const pageTitle = i === 0 || sections[i - 1].page !== item.page ? normalize(item.page) : "";
    const sectionScore = words.every(w => body.includes(w) || name.includes(w)) ?
      1 + words.filter(w => name.includes(w)).length * 3 + Number(name.includes(query))*5 : 0;
    const score = pageTitle.includes(query) ? Math.max(sectionScore, pageTitle === query ? 100 : 5) : sectionScore;
    return {item,score};
  }).filter(x => x.score).sort((a,b) => b.score-a.score).slice(0,15);
  for (const {item} of matches) {
    const a = document.createElement("a"), small = document.createElement("small");
    a.href = item.href;
    a.append(document.createTextNode(item.title));
    small.textContent = item.page;
    a.append(small);
    a.onclick = () => showMenu(false);
    results.append(a);
  }
  if (!matches.length) results.textContent = strings.empty;
}
field.addEventListener("input", search);
document.addEventListener("keydown", e => {
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault(); showMenu(true); field.focus();
  } else if (e.key === "Escape") {
    field.value = ""; search(); showMenu(false); field.blur();
  } else if (e.key === "Enter" && e.target === field) results.querySelector("a")?.click();
});
for (const b of document.querySelectorAll(".copy")) {
  b.hidden = false;
  b.addEventListener("click", async () => {
    const block = b.closest(".sample").querySelector("pre code");
    try {
      await navigator.clipboard.writeText(block.textContent);
      b.textContent = strings.copied;
    } catch {
      const range = document.createRange(); range.selectNodeContents(block);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      b.textContent = strings.manual;
    }
    setTimeout(()=>b.textContent=strings.copy,1800);
  });
}
const localLinks = [...document.querySelectorAll(".toc a")];
function updateLocation() {
  let active = localLinks[0];
  for (const a of localLinks) {
    if (document.getElementById(a.hash.slice(1)).getBoundingClientRect().top <= 120) active = a;
  }
  if (window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
    const anchor = localLinks.find(a => a.hash === location.hash);
    active = anchor && document.getElementById(anchor.hash.slice(1)).getBoundingClientRect().top < window.innerHeight
      ? anchor : localLinks.at(-1);
  }
  localLinks.forEach(a => a.classList.toggle("current", a === active));
}
function openLinkedSchema() {
  const target = document.getElementById(location.hash.slice(1));
  if (target?.matches("details.api-schema") && !target.open) {
    target.open = true;
    target.scrollIntoView();
  }
  updateLocation();
}
window.addEventListener("scroll", updateLocation, {passive: true});
window.addEventListener("hashchange", openLinkedSchema);
openLinkedSchema();
