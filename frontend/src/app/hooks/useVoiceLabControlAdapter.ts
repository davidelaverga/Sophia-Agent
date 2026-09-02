'use client';

import { useEffect, useRef } from 'react';

import { recordSophiaCaptureEvent } from '../lib/session-capture';

type VoiceLabControlAction = 'session-start' | 'voice-start';

type VoiceLabControlReceipt = {
  ok: true;
  schema: 'sophia_voice_lab_control_adapter_v1';
  action: VoiceLabControlAction;
  test_run_id: string;
  scenario_id: string | null;
  scenario_version: string | null;
  cleanup_obligation_id: string;
  expected_deployment: {
    frontend: string;
    backend: string;
    voice: string;
  };
  control_epoch_sha256: string;
  expires_at: number;
  ordinary_user_access: false;
};

function isControlReceipt(value: unknown, action: VoiceLabControlAction): value is VoiceLabControlReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<VoiceLabControlReceipt>;
  const deployment = receipt.expected_deployment;
  return receipt.ok === true
    && receipt.schema === 'sophia_voice_lab_control_adapter_v1'
    && receipt.action === action
    && typeof receipt.test_run_id === 'string'
    && typeof receipt.cleanup_obligation_id === 'string'
    && typeof receipt.control_epoch_sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(receipt.control_epoch_sha256)
    && Number.isInteger(receipt.expires_at)
    && Number(receipt.expires_at) > Math.floor(Date.now() / 1000)
    && receipt.ordinary_user_access === false
    && Boolean(deployment)
    && typeof deployment?.frontend === 'string'
    && typeof deployment?.backend === 'string'
    && typeof deployment?.voice === 'string';
}

export function useVoiceLabControlAdapter(
  action: VoiceLabControlAction,
  invokeExistingAction: () => void | Promise<void>,
): void {
  const invokedRef = useRef(false);
  const invokeExistingActionRef = useRef(invokeExistingAction);

  useEffect(() => {
    invokeExistingActionRef.current = invokeExistingAction;
  }, [invokeExistingAction]);

  useEffect(() => {
    if (invokedRef.current) return;
    const controller = new AbortController();

    void (async () => {
      const response = await fetch(`/api/voice-lab/control/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) return;
      const receipt: unknown = await response.json();
      if (!isControlReceipt(receipt, action) || invokedRef.current || controller.signal.aborted) return;
      invokedRef.current = true;
      recordSophiaCaptureEvent({
        category: 'voice-lab-control',
        name: 'authorized-action',
        payload: receipt,
      });
      await invokeExistingActionRef.current();
    })().catch(() => undefined);

    return () => controller.abort();
  }, [action]);
}
