'use strict';

// src/types/common.ts
var DataLoadingStatus = /* @__PURE__ */ ((DataLoadingStatus2) => {
  DataLoadingStatus2["Idle"] = "idle";
  DataLoadingStatus2["Loading"] = "loading";
  DataLoadingStatus2["Success"] = "success";
  DataLoadingStatus2["Error"] = "error";
  return DataLoadingStatus2;
})(DataLoadingStatus || {});

// src/types/agent.ts
var AgentType = /* @__PURE__ */ ((AgentType2) => {
  AgentType2["SmartAssistant"] = "smart-assistant";
  AgentType2["SurveyAgent"] = "survey-agent";
  AgentType2["CommerceAgent"] = "commerce-agent";
  AgentType2["Flow"] = "flow";
  return AgentType2;
})(AgentType || {});

// src/types/flow.ts
var FlowChunkType = /* @__PURE__ */ ((FlowChunkType2) => {
  FlowChunkType2["FlowStart"] = "flowStart";
  FlowChunkType2["FlowStepStart"] = "flowStepStart";
  FlowChunkType2["FlowFinish"] = "flowFinish";
  FlowChunkType2["Generation"] = "generation";
  FlowChunkType2["GenerationEnd"] = "generationEnd";
  FlowChunkType2["ToolCalls"] = "toolCalls";
  FlowChunkType2["TextStream"] = "textStream";
  FlowChunkType2["FinalResult"] = "finalResult";
  FlowChunkType2["Error"] = "error";
  FlowChunkType2["Message"] = "message";
  FlowChunkType2["UIComponent"] = "uiComponent";
  return FlowChunkType2;
})(FlowChunkType || {});

exports.AgentType = AgentType;
exports.DataLoadingStatus = DataLoadingStatus;
exports.FlowChunkType = FlowChunkType;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map