'use client';

import { useEffect } from 'react';

import { registerSophiaCaptureBridge } from '../lib/session-capture';

export function SessionCaptureBridge() {
  useEffect(() => {
    registerSophiaCaptureBridge();
  }, []);

  return null;
}