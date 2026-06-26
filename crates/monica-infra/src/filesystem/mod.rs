pub mod notebook;
pub mod paths;

mod notebook_gateway;
mod outputs;
mod scaffold;
mod workspace;

pub use notebook_gateway::FsNotebookGateway;
pub use outputs::FsTaskRunOutputs;
pub use scaffold::scaffold_monica;
pub use workspace::FsWorkspace;
