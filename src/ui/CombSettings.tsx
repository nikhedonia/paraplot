export interface CombSettingsProps {
  density: number;
  scale: number;
  onDensity: (value: number) => void;
  onScale: (value: number) => void;
}

/** Sliders shared by the 2D and 3D curvature combs. */
export function CombSettings({ density, scale, onDensity, onScale }: CombSettingsProps) {
  return (
    <div className="comb-settings">
      <label className="comb-set" title="Number of comb spikes along the curve">
        <span>density</span>
        <input
          type="range"
          min={8}
          max={120}
          step={1}
          value={density}
          onChange={(e) => onDensity(e.currentTarget.valueAsNumber)}
        />
        <em>{density}</em>
      </label>
      <label className="comb-set" title="Spike length multiplier">
        <span>scale</span>
        <input
          type="range"
          min={0.2}
          max={3}
          step={0.05}
          value={scale}
          onChange={(e) => onScale(e.currentTarget.valueAsNumber)}
        />
        <em>{scale.toFixed(2)}</em>
      </label>
    </div>
  );
}
