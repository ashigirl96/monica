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
#[serde(rename_all = "camelCase")]
pub struct Unread {
    pub terminal_session_ids: Vec<String>,
}

impl Unread {
    /// 終了でない Agent Session は Terminal Session に 1 つまでなので、id の数が未読の数になる。
    pub fn dock_count(&self) -> Option<i64> {
        // tauri の macOS 実装は Some(0) を "0" の label にして出すので、None で消す。
        i64::try_from(self.terminal_session_ids.len())
            .ok()
            .filter(|&count| count > 0)
    }
}

/// Backend が stdout に書く Shell 宛ての JSON 行のうち、Shell が解釈するもの。
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Announcement {
    Endpoint(Endpoint),
    Notify(Notification),
    Unread(Unread),
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
    fn reads_the_unread_line() {
        assert_eq!(
            parse(r#"{"type":"unread","terminalSessionIds":["ts-1","ts-2"]}"#),
            Some(Announcement::Unread(Unread {
                terminal_session_ids: vec!["ts-1".into(), "ts-2".into()],
            })),
        );
    }

    #[test]
    fn the_dock_shows_how_many_terminal_sessions_are_unread_and_clears_at_none() {
        let unread = |ids: &[&str]| Unread {
            terminal_session_ids: ids.iter().map(|id| id.to_string()).collect(),
        };
        assert_eq!(unread(&[]).dock_count(), None);
        assert_eq!(unread(&["ts-1", "ts-2", "ts-3"]).dock_count(), Some(3));
    }

    #[test]
    fn leaves_lines_it_does_not_relay_to_the_log() {
        assert_eq!(parse(r#"{"type":"notify","title":"monica#43"}"#), None);
        assert_eq!(
            parse(r#"{"type":"notify","title":"monica#43","body":"手空き"}"#),
            None
        );
        assert_eq!(parse(r#"{"type":"endpoint","port":"x"}"#), None);
        assert_eq!(
            parse(r#"{"type":"unread","terminalSessionIds":"ts-1"}"#),
            None
        );
        assert_eq!(parse("[backend] stray print"), None);
    }
}
