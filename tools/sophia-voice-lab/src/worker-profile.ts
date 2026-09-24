import { readFileSync } from 'node:fs';

import { VoiceLabError, labError } from './domain.js';

export const ACTIVE_RUN_MIN_CPU = 2;
export const ACTIVE_RUN_MIN_MEMORY_BYTES = 3.5 * 1024 ** 3;

export interface WorkerProfile {
  schema: 'sophia_voice_lab_worker_profile_v1';
  status: 'sufficient' | 'insufficient' | 'unavailable';
  cpu_quota: number | null;
  memory_limit_bytes: number | null;
  cpu_source: 'cgroup_v2' | 'cgroup_v1' | null;
  memory_source: 'cgroup_v2' | 'cgroup_v1' | null;
  minimum_cpu: 2;
  minimum_memory_bytes: number;
}

type Reader = (path: string) => string | null;
const defaultReader: Reader = (path) => {
  try { return readFileSync(path, 'utf8').trim(); } catch { return null; }
};

export function measureWorkerProfile(read: Reader = defaultReader): WorkerProfile {
  const v2Cpu = read('/sys/fs/cgroup/cpu.max')?.split(/\s+/);
  const v1Quota = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const v1Period = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  const cpuV2 = v2Cpu?.length === 2 && v2Cpu[0] !== 'max' ? Number(v2Cpu[0]) / Number(v2Cpu[1]) : null;
  const cpuV1 = v1Quota > 0 && v1Period > 0 ? v1Quota / v1Period : null;
  const cpu = cpuV2 !== null && Number.isFinite(cpuV2) && cpuV2 > 0 ? cpuV2 : cpuV1 !== null && Number.isFinite(cpuV1) ? cpuV1 : null;
  const v2Memory = read('/sys/fs/cgroup/memory.max');
  const v1Memory = read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const memoryV2 = v2Memory && v2Memory !== 'max' ? Number(v2Memory) : null;
  const memoryV1 = v1Memory ? Number(v1Memory) : null;
  const memory = memoryV2 !== null && Number.isSafeInteger(memoryV2) && memoryV2 > 0 ? memoryV2
    : memoryV1 !== null && Number.isSafeInteger(memoryV1) && memoryV1 > 0 ? memoryV1 : null;
  return {
    schema: 'sophia_voice_lab_worker_profile_v1',
    status: cpu === null || memory === null ? 'unavailable' : cpu >= ACTIVE_RUN_MIN_CPU && memory >= ACTIVE_RUN_MIN_MEMORY_BYTES ? 'sufficient' : 'insufficient',
    cpu_quota: cpu,
    memory_limit_bytes: memory,
    cpu_source: cpuV2 !== null && cpu === cpuV2 ? 'cgroup_v2' : cpuV1 !== null && cpu === cpuV1 ? 'cgroup_v1' : null,
    memory_source: memoryV2 !== null && memory === memoryV2 ? 'cgroup_v2' : memoryV1 !== null && memory === memoryV1 ? 'cgroup_v1' : null,
    minimum_cpu: ACTIVE_RUN_MIN_CPU,
    minimum_memory_bytes: ACTIVE_RUN_MIN_MEMORY_BYTES,
  };
}

export function assertActiveRunWorkerProfile(nodeEnv: string, profile: WorkerProfile): void {
  if (nodeEnv === 'test') return;
  if (profile.status !== 'sufficient') {
    throw new VoiceLabError(labError('WORKER_PROFILE_INSUFFICIENT', 'Active voice runs require a measured cgroup quota of at least 2 CPUs and 3.5 GiB.', 'deployment', true, {
      profile_status: profile.status, cpu_quota: profile.cpu_quota, memory_limit_bytes: profile.memory_limit_bytes,
    }));
  }
}
