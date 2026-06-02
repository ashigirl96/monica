use anyhow::Result;

use crate::{GithubAuthStatus, GithubDeviceFlow};

use super::BoxFuture;

pub trait AuthGateway {
    fn status(&self) -> GithubAuthStatus;
    fn begin_device_flow<'a>(&'a self) -> BoxFuture<'a, Result<GithubDeviceFlow>>;
    fn wait_for_device_flow<'a>(
        &'a self,
        flow: &'a GithubDeviceFlow,
    ) -> BoxFuture<'a, Result<GithubAuthStatus>>;
    fn logout<'a>(&'a self) -> BoxFuture<'a, Result<()>>;
    fn github_app_install_url(&self) -> String;
}
