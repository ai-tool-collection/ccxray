// Anthropic SSE event parser for buildMergedSteps.
// Handles content_block_start/delta/stop events → shared step state.
window.RENDERERS.anthropic = {
  processEvent(ev, state) {
    if (ev.type === 'content_block_start') {
      if (ev.content_block?.type === 'thinking') {
        state.curThinking = '';
        state.curThinkingStart = ev._ts || null;
      } else if (ev.content_block?.type === 'tool_use') {
        state.curToolUses.push({
          index: ev.index,
          name: ev.content_block.name,
          id: ev.content_block.id,
          inputChunks: [],
        });
      }
    } else if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'thinking_delta') {
        if (state.curThinking !== null) state.curThinking += ev.delta.thinking || '';
      } else if (ev.delta?.type === 'input_json_delta') {
        const tu = state.curToolUses.find(t => t.index === ev.index);
        if (tu) tu.inputChunks.push(ev.delta.partial_json || '');
      } else if (ev.delta?.type === 'text_delta') {
        state.curText += ev.delta.text || '';
      }
    } else if (ev.type === 'content_block_stop') {
      if (state.curThinkingStart && !state.curThinkingEnd) state.curThinkingEnd = ev._ts || null;
    }
  },
};
