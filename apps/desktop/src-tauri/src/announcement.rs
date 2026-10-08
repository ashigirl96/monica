use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub title: String,
    pub body: String,
    pub terminal_session_id: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct UnreadCount {
    pub count: u32,
}

impl UnreadCount {
    pub fn dock_count(&self) -> Option<i64> {
        // tauri の macOS 実装は Some(0) を "0" の label にして出すので、None で消す。
        (self.count > 0).then_some(i64::from(self.count))
    }
}

/// Backend が stdout に書く Shell 宛ての JSON 行のうち、Shell が解釈するもの。
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Announcement {
    Endpoint(Endpoint),
    Notify(Notification),
    Badge(UnreadCount),
}

pub fn parse(line: &str) -> Option<Announcement> {
    serde_json::from_str(line).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_endpoint_line() {
        assert_eq!(
            parse(r#"{"type":"endpoint","port":51234,"token":"t-1"}"#),
            Some(Announcement::Endpoint(Endpoint {
                port: 51234,
                token: "t-1".into()
            })),
        );
    }

    #[test]
    fn reads_the_notify_line() {
        assert_eq!(
            parse(
                r#"{"type":"notify","title":"monica#43","body":"手空き","terminalSessionId":"ts-1"}"#
            ),
            Some(Announcement::Notify(Notification {
                title: "monica#43".into(),
                body: "手空き".into(),
                terminal_session_id: "ts-1".into(),
            })),
        );
    }

    #[test]
    fn reads_the_badge_line() {
        assert_eq!(
            parse(r#"{"type":"badge","count":3}"#),
            Some(Announcement::Badge(UnreadCount { count: 3 })),
        );
    }

    #[test]
    fn a_badge_of_zero_clears_the_dock() {
        assert_eq!(UnreadCount { count: 0 }.dock_count(), None);
        assert_eq!(UnreadCount { count: 3 }.dock_count(), Some(3));
    }

    #[test]
    fn leaves_lines_it_does_not_relay_to_the_log() {
        assert_eq!(parse(r#"{"type":"notify","title":"monica#43"}"#), None);
        assert_eq!(
            parse(r#"{"type":"notify","title":"monica#43","body":"手空き"}"#),
            None
        );
        assert_eq!(parse(r#"{"type":"endpoint","port":"x"}"#), None);
        assert_eq!(parse(r#"{"type":"badge","count":-1}"#), None);
        assert_eq!(parse("[backend] stray print"), None);
    }
}
