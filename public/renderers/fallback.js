// Fallback renderer for unknown providers — no-op event processing.
window.RENDERERS.fallback = {
  processEvent(_ev, _state) {},
};
