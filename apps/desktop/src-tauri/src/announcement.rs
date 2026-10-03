use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct Notification {
    pub title: String,
    pub body: String,
}

/// Backend が stdout に書く Shell 宛ての JSON 行のうち、Shell が解釈するもの。
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Announcement {
    Endpoint(Endpoint),
    Notify(Notification),
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
            parse(r#"{"type":"notify","title":"tania#43","body":"手空き"}"#),
            Some(Announcement::Notify(Notification {
                title: "tania#43".into(),
                body: "手空き".into()
            })),
        );
    }

    #[test]
    fn leaves_lines_it_does_not_relay_to_the_log() {
        assert_eq!(parse(r#"{"type":"notify","title":"tania#43"}"#), None);
        assert_eq!(parse(r#"{"type":"endpoint","port":"x"}"#), None);
        assert_eq!(parse("[backend] stray print"), None);
    }
}
