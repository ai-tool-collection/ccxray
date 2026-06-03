// RENDERERS registry — per-provider event parsing for buildMergedSteps.
// Each renderer implements processEvent(ev, state) to translate provider-native
// SSE/WS events into the shared step-building state (curThinking, curToolUses, curText).
window.RENDERERS = {};
window.getRenderer = function(provider) {
  return window.RENDERERS[provider] || window.RENDERERS.fallback;
};
