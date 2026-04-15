# ADR-004: Critical Path Method (CPM) + WSJF for task scheduling and prioritisation

**Status:** accepted  
**Date:** 2026-04-15

## Context

A project manager needs to identify which tasks determine the minimum project duration and which have scheduling flexibility. Simple priority lists miss dependency structure. Business value needs to be weighed against duration cost.

## Decision

Implement CPM with forward pass (early start/finish) and backward pass (late start/finish). Store early_start, early_finish, late_start, late_finish, float_days, is_critical on each task. Overlay WSJF (value_score / duration_days) for business value prioritisation — higher WSJF = do first within float. Recompute on demand via crux_cpm. Persist CPM results to DB for reporting without recomputation.

## Consequences

Data model must enforce DAG constraints — cycles throw on CPM computation. Float of zero means any delay delays the project. WSJF requires value_score to be set; tasks without it show null WSJF. CPM results are stale after any task or dependency change until recomputed.