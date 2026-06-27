use anyhow::Result;

use super::{TaskRunStore, TaskStore, WorkbenchStore};

/// Opens a use-case-scoped transaction over the stores a single operation needs to mutate as one
/// unit. The returned [`WorkTransaction`] borrows the backing store for its lifetime; nothing is
/// persisted until [`WorkTransaction::commit`] — dropping it rolls back.
///
/// `begin` takes `&mut self`: the exclusive borrow is what enforces "at most one transaction open
/// at a time" in the type system — the backing store cannot be touched again until the transaction
/// commits or is dropped.
pub trait UnitOfWork {
    fn begin(&mut self) -> Result<Box<dyn WorkTransaction + '_>>;
}

/// A live transaction exposing the stores a use case writes through. Every write lands in the
/// transaction; `commit` consumes it to make the changes durable. Implementors that hold an SQLite
/// `Transaction` roll back on drop, so a returned `Err` before `commit` leaves nothing behind.
pub trait WorkTransaction: TaskStore + TaskRunStore + WorkbenchStore {
    fn commit(self: Box<Self>) -> Result<()>;
}
