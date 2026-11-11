//! Saltline's salvage economy (docs/ECONOMY.md, docs/CONTRACT_API.md).
//!
//! - `items.rs`: the item table and run rules (data)
//! - `pricing.rs`: the pricing rules (the one readable file)
//! - `policy.rs`: the default broker policy
//!
//! Integers only: amounts are whole scrip in `u128`, times are block milliseconds in `u64`.

pub mod items;
pub mod policy;
pub mod pricing;
