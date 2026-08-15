import { createVectraExecuteTool, createVectraNativePolicy, createVectraResultMiddleware, resolveConfig } from './lib.js';

export default {
  id: 'vectra-tool-wrapper',
  name: 'Vectra Tool Wrapper',
  description: 'Routes authorized tool execution through Vectra ATP enforcement.',
  register(api) {
    const config = resolveConfig(api.pluginConfig ?? {});
    api.registerTrustedToolPolicy(createVectraNativePolicy(config));
    api.registerAgentToolResultMiddleware(createVectraResultMiddleware(config), { runtimes: ['openclaw', 'codex'] });
    if (config.wrapperEnabled) api.registerTool(createVectraExecuteTool(config));
  },
};
