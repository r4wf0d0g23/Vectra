import { createVectraExecuteTool, createVectraNativeEnforcement, resolveConfig } from './lib.js';

export default {
  id: 'vectra-tool-wrapper',
  name: 'Vectra Tool Wrapper',
  description: 'Routes authorized tool execution through Vectra ATP enforcement.',
  register(api) {
    const config = resolveConfig(api.pluginConfig ?? {});
    const native = createVectraNativeEnforcement(config);
    api.registerTrustedToolPolicy(native.policy);
    api.registerAgentToolResultMiddleware(native.middleware, { runtimes: ['openclaw', 'codex'] });
    api.lifecycle?.registerRuntimeLifecycle?.({ id: 'vectra-native-leases', description: 'Stop Vectra native execution lease heartbeats.', cleanup: native.close });
    if (config.wrapperEnabled) api.registerTool(createVectraExecuteTool(config));
  },
};
