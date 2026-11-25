import type { RuntimeKind } from '@serverforge/shared';
import type { RuntimeMode } from '../config.js';
import type { QueryService } from '../query/query-service.js';
import { DockerRuntimeAdapter } from './docker-runtime.js';
import { MockRuntimeAdapter } from './mock-runtime.js';
import { NativeProcessRuntimeAdapter } from './native-runtime.js';
import type { RuntimeAdapter } from './runtime-adapter.js';

export class RuntimeManager {
  public readonly docker: DockerRuntimeAdapter;
  public readonly native: NativeProcessRuntimeAdapter;
  public readonly mock: MockRuntimeAdapter;

  constructor(
    public readonly mode: RuntimeMode,
    toolsDir: string,
    queryService: QueryService
  ) {
    this.docker = new DockerRuntimeAdapter(queryService);
    this.native = new NativeProcessRuntimeAdapter(toolsDir, queryService);
    this.mock = new MockRuntimeAdapter();
  }

  async getAvailability(): Promise<{ docker: boolean; native: boolean; mock: boolean }> {
    if (this.mode === 'mock') {
      return { docker: false, native: false, mock: true };
    }
    const dockerOk = this.mode === 'native' ? false : await this.docker.isAvailable();
    const nativeOk = this.mode !== 'docker';
    return { docker: dockerOk, native: nativeOk, mock: false };
  }

  async resolveAdapter(preferred: RuntimeKind): Promise<RuntimeAdapter> {
    if (this.mode === 'mock') {
      return this.mock;
    }

    if (preferred === 'docker') {
      if (this.mode === 'native') {
        throw new Error('Docker runtime is disabled (RUNTIME_MODE=native).');
      }
      if (!(await this.docker.isAvailable())) {
        throw new Error(
          'Docker Engine is not reachable. Start Docker Desktop on Windows 11, or switch this instance to the Native runtime.'
        );
      }
      return this.docker;
    }

    if (this.mode === 'docker') {
      throw new Error('Native runtime is disabled (RUNTIME_MODE=docker).');
    }
    return this.native;
  }
}
