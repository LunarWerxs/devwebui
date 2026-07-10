export interface InstanceInfo {
  port: number;
  url: string;
  pid: number;
  startedAt: number;
}

export interface InstancePointerOptions {
  /** Resolved config dir; runtime.json is written inside it. */
  configDir: string;
  /** If set, findLiveInstance also requires the health body's `service` to equal this. */
  serviceName?: string;
  /** Host used in the recorded url (default "127.0.0.1"). */
  host?: string;
}

export interface InstancePointer {
  instanceFilePath(): string;
  writeInstanceInfo(port: number): void;
  readInstanceInfo(): InstanceInfo | null;
  clearInstanceInfo(): void;
  findLiveInstance(timeoutMs?: number): Promise<InstanceInfo | null>;
}

export function createInstancePointer(opts: InstancePointerOptions): InstancePointer;
