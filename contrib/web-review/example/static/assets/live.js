// Hot reload: styles swap in place, anything else reloads the current route.
const events = new EventSource("__live");
events.addEventListener("change", (e) => {
  const paths = JSON.parse(e.data);
  if (!paths.every((p) => p.endsWith(".css"))) return location.reload();
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const url = new URL(link.href);
    url.searchParams.set("v", Date.now());
    link.href = url.href;
  }
});
