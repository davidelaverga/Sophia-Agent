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

function positiveFinite(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function cpuLimits(read: Reader): { value: number | null; source: WorkerProfile['cpu_source'] } {
  const v2 = read('/sys/fs/cgroup/cpu.max')?.split(/\s+/);
  const v2Quota = v2?.length === 2 ? positiveFinite(Number(v2[0]) / Number(v2[1])) : null;
  if (v2Quota !== null) return { value: v2Quota, source: 'cgroup_v2' };
  const v1Quota = positiveFinite(Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')));
  const v1Period = positiveFinite(Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us')));
  const value = v1Quota !== null && v1Period !== null ? positiveFinite(v1Quota / v1Period) : null;
  return { value, source: value === null ? null : 'cgroup_v1' };
}

function memoryLimits(read: Reader): { value: number | null; source: WorkerProfile['memory_source'] } {
  const v2 = Number(read('/sys/fs/cgroup/memory.max'));
  if (Number.isSafeInteger(v2) && v2 > 0) return { value: v2, source: 'cgroup_v2' };
  const v1 = Number(read('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  if (Number.isSafeInteger(v1) && v1 > 0) return { value: v1, source: 'cgroup_v1' };
  return { value: null, source: null };
}

export function measureWorkerProfile(read: Reader = defaultReader): WorkerProfile {
  const cpu = cpuLimits(read);
  const memory = memoryLimits(read);
  const status = cpu.value === null || memory.value === null ? 'unavailable'
    : cpu.value >= ACTIVE_RUN_MIN_CPU && memory.value >= ACTIVE_RUN_MIN_MEMORY_BYTES ? 'sufficient' : 'insufficient';
  return {
    schema: 'sophia_voice_lab_worker_profile_v1',
    status,
    cpu_quota: cpu.value,
    memory_limit_bytes: memory.value,
    cpu_source: cpu.source,
    memory_source: memory.source,
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
