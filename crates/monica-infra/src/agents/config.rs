use monica_application::Agent;

/// Hook events an agent emits beyond the standard set (SessionStart, UserPromptSubmit,
/// Pre/PostToolUse, Stop, SubagentStart, SubagentStop). The worktree hook config registers these so
/// the agent calls back on them; the decoder must recognize the same set, which is why the two live
/// together in this module.
pub fn extra_hook_events(agent: Agent) -> &'static [&'static str] {
    match agent {
        Agent::Claude => &["StopFailure", "SessionEnd"],
        Agent::Codex => &["PermissionRequest"],
    }
}

/// Where an agent's hook config file lives, relative to the worktree root.
pub fn hooks_config_path(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => ".claude/settings.local.json",
        Agent::Codex => ".codex/hooks.json",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_extra_hook_events() {
        let events = extra_hook_events(Agent::Claude);
        assert!(events.contains(&"StopFailure"));
        assert!(events.contains(&"SessionEnd"));
        assert!(!events.contains(&"PermissionRequest"));
    }

    #[test]
    fn codex_extra_hook_events() {
        let events = extra_hook_events(Agent::Codex);
        assert!(events.contains(&"PermissionRequest"));
        assert!(!events.contains(&"StopFailure"));
        assert!(!events.contains(&"SessionEnd"));
    }

    #[test]
    fn hook_config_paths() {
        assert_eq!(hooks_config_path(Agent::Claude), ".claude/settings.local.json");
        assert_eq!(hooks_config_path(Agent::Codex), ".codex/hooks.json");
    }
}
