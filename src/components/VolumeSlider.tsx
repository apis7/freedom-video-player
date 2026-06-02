import { useAppStore } from "../state/appStore";
import { playback } from "../ipc";

const SNAP_MIN = 101;
const SNAP_MAX = 104;
const BOOST_THRESHOLD = 100;

export function VolumeSlider() {
  const volume = useAppStore((s) => s.volume);
  const muted = useAppStore((s) => s.muted);

  const display = muted ? 0 : volume;
  const inBoost = !muted && volume > BOOST_THRESHOLD;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let v = Number(e.target.value);
    // Snap zone: dragging into 101-104 sticks at 100. To enter "boost" the user
    // must drag past 104. Coming back down from boost works normally.
    if (v >= SNAP_MIN && v <= SNAP_MAX) v = 100;
    useAppStore.setState({ volume: v, muted: false });
    void playback.setVolume(v);
    if (muted) void playback.setMuted(false);
  };

  return (
    <input
      type="range"
      min={0}
      max={125}
      step={1}
      value={display}
      onChange={handleChange}
      title={`Volume ${Math.round(display)}%${inBoost ? " (boosted)" : ""}`}
      className="w-20 cursor-pointer"
      style={{ accentColor: inBoost ? "#f85149" : "#4f8cff" }}
    />
  );
}
