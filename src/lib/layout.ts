// tauri.conf.json の trafficLightPosition: { x: 16, y: 22 } に対応
// macOS traffic light ボタン直径 ≈ 12px, 間隔 ≈ 8px, 3個
export const TRAFFIC_LIGHT_ZONE_HEIGHT = 40; // y(22) + buttonHeight(12) + padding(6)
export const TRAFFIC_LIGHT_ZONE_WIDTH = 96; // x(16) + buttons(52) + padding(28)
