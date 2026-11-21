import type { Aabb, Material, Vec3 } from '../core/types';
import type { RenderSettings } from './settings';

export interface CameraState {
  yaw: number;
  pitch: number;
  dist: number;
  target: Vec3;
  fov: number;
}

/** the part of a compiled program the renderer needs */
export interface RenderScene {
  glsl: string;
  values: Float32Array;
  materials: Material[];
  bounds: Aabb;
}

export interface FrameArgs {
  camera: CameraState;
  settings: RenderSettings;
  /** css pixels */
  width: number;
  height: number;
  dpr: number;
  time: number;
  floorY: number;
  /** internal resolution scale (quality × draft × adaptive) */
  scale: number;
  /** ask the worker to finish the GPU work so this frame can be timed */
  probe?: boolean;
}

export interface FrameInfo {
  width: number;
  height: number;
  /** wall time spent drawing (including gl.finish for probe frames) */
  renderMs?: number;
}

export interface BackendHooks {
  /** called after a frame has been drawn (possibly off-thread) */
  onFrame: (info: FrameInfo) => void;
  onError: (message: string | null) => void;
  /** the GPU context is gone; the viewport should recreate the backend */
  onContextLost?: () => void;
}

export interface RenderBackend {
  readonly offscreen: boolean;
  /** true while a worker frame is in flight (always false for the main thread) */
  readonly busy: boolean;
  setScene(scene: RenderScene): void;
  render(args: FrameArgs): void;
  snapshot(): Promise<string | null>;
  dispose(): void;
}
