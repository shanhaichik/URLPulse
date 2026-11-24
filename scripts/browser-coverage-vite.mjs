import { createInstrumenter } from 'istanbul-lib-instrument';
import { mergeConfig } from 'vite';
import appConfig from '../vite.config.ts';

export default mergeConfig(appConfig, {
  plugins: [{
    name: 'pulse-react-coverage',
    enforce: 'post',
    transform(code, id) {
      const filename = id.replaceAll('\\', '/');
      if (!filename.includes('/src/client/') || !/\.tsx?$/.test(filename)) return;
      const instrumenter = createInstrumenter({
        esModules: true, produceSourceMap: true, coverageGlobalScope: 'globalThis', coverageGlobalScopeFunc: false,
      });
      const instrumented = instrumenter.instrumentSync(code, id, this.getCombinedSourcemap());
      return { code: instrumented, map: instrumenter.lastSourceMap() };
    },
  }],
});
