import { createVectraExecuteTool, createVectraOnlyPolicy, resolveConfig } from './lib.js';

export default {
  id: 'vectra-tool-wrapper',
  name: 'Vectra Tool Wrapper',
  description: 'Routes authorized tool execution through Vectra ATP enforcement.',
  register(api) {
    const config = resolveConfig(api.pluginConfig ?? {});
    api.registerTrustedToolPolicy(createVectraOnlyPolicy(config.protectedAgentIds));
    api.registerTool(createVectraExecuteTool(config));
  },
};
