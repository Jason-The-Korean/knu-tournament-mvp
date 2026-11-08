// One request at a time; invalidate/abort on route changes and hidden tabs.
export function recruitmentRefresh({ fetchState, apply, onError, visible = () => !document.hidden, schedule = setTimeout, cancel = clearTimeout, interval = 12000 }) {
  let generation = 0, target = null, timer = null, pending = null;
  const clear = () => { if (timer !== null) cancel(timer); timer = null; };
  function stop() { generation++; target = null; clear(); pending?.abort(); }
  function later() { clear(); if (target && visible()) timer = schedule(() => { timer = null; void refresh(); }, interval); }
  async function refresh() {
    clear(); if (!target || !visible() || pending) return;
    const current = generation, id = target, controller = new AbortController(); pending = controller;
    try {
      const item = await fetchState(id, controller.signal);
      if (current !== generation || target !== id || !visible()) return;
      apply(item);
      if (!item || item.status !== 'open' || item.bracket) { target = null; clear(); }
    } catch (error) { if (current === generation && !controller.signal.aborted) onError(error); }
    finally { if (pending === controller) pending = null; later(); }
  }
  return {
    start(id) { stop(); target = id; later(); }, stop, refresh,
    visibilityChanged() {
      if (!visible()) { generation++; clear(); pending?.abort(); }
      else void refresh();
    },
  };
}
