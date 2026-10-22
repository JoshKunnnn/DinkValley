# EXISTING CODEBASE: INTEGRATION, CONSISTENCY, AND FEATURE OVERLAP AUDIT

## OBJECTIVE

Audit my existing codebase to determine whether all features, modules, services, APIs, database entities, and user workflows are correctly integrated and working together.

I do NOT want a new implementation, redesign, or refactoring at this stage.

I want to identify:

* Features that duplicate or overlap with other features.
* Modules that exist but are not properly connected.
* Frontend components calling incorrect or outdated APIs.
* Backend endpoints that are unused, duplicated, or inconsistent.
* Database models, tables, fields, and relationships that do not align with application logic.
* Conflicting business rules or competing sources of truth.
* Broken dependencies between features.
* Inconsistent naming, data types, validation, authentication, authorization, and error handling.
* Features that appear complete in the UI but do not function end to end.
* Dead code, unreachable code, unused components, and obsolete implementations.
* Potential runtime errors, race conditions, state inconsistencies, and integration failures.
* Existing AI-generated or speculative implementations that are not supported by the actual system requirements.

## RULE 1: PRESERVE THE EXISTING CODEBASE

This is an AUDIT-ONLY task.

Do not modify, delete, rename, create, refactor, or automatically fix application files.

Do not run destructive commands or database migrations.

Do not assume that a feature is broken merely because it looks unusual. Verify the actual implementation and its expected behavior.

## RULE 2: TRACE EVERY FEATURE THROUGH THE SYSTEM

For each major feature, trace its complete execution path:

User action
→ Frontend component
→ State management and validation
→ API request or server action
→ Backend route/controller
→ Business logic/service
→ Database query or external integration
→ Response handling
→ Frontend state update
→ Final user-visible result.

Adapt this sequence to the actual architecture. Some applications may use server components, server actions, event-driven services, or other patterns.

Verify that each connection uses the correct:

* Function or endpoint.
* Request and response format.
* Field names and data types.
* Authentication and authorization rules.
* Database model and relationships.
* Error and loading states.
* State updates and invalidation mechanisms.

Do not declare a feature fully integrated simply because its files exist.

## RULE 3: DETECT DUPLICATED AND OVERLAPPING FEATURES

Search for multiple implementations of the same responsibility.

Check for:

* Similar features implemented in different modules.
* Multiple endpoints performing the same operation.
* Repeated business logic in controllers, services, hooks, or components.
* Duplicate database models or overlapping tables.
* Different naming conventions for the same underlying concept.
* Multiple ways to create, update, retrieve, or delete the same data.
* Conflicting validation or permission rules.
* Multiple state stores managing the same information.
* Old implementations still referenced by some parts of the application.
* UI features that overlap but behave differently.

Do not label code as a duplicate based on names alone. Compare its actual behavior, purpose, data ownership, dependencies, and callers.

Classify each finding as:
A. Confirmed duplication.
B. Functional overlap that may be intentional.
C. Legacy implementation that may be obsolete.
D. Unused or unreachable code.
E. Insufficient evidence to determine whether duplication exists.

Explain the evidence for each classification.

## RULE 4: VERIFY CROSS-MODULE COMPATIBILITY

Inspect the connections between related modules.

Check whether:

* Imports and exports resolve correctly.
* Function signatures match their callers.
* API request and response contracts match.
* Database fields match the code that reads and writes them.
* Types and interfaces are consistent.
* Authentication and permissions are enforced consistently.
* Shared components and services are used correctly.
* Related features agree on business rules.
* Changes in one module can break another module.
* Caches, queries, and frontend state are refreshed when necessary.
* Transactions and multi-step operations preserve data integrity.

Identify both direct errors and plausible integration risks. Clearly distinguish verified failures from risks that still need testing.

## RULE 5: RUN SAFE VERIFICATION

Inspect the available package scripts, test configuration, type checking, linting, build configuration, and existing automated tests.

Run suitable, non-destructive checks when the environment permits.

Potential checks include:

* Static analysis and type checking.
* Linting.
* Unit tests.
* Integration tests.
* Existing end-to-end tests.
* Production build.
* Dependency and import validation.
* API contract validation.
* Database schema and migration consistency.

Do not install packages, alter dependencies, reset databases, or modify configuration without approval.

Do not use production data or trigger real external side effects during testing.

Report the exact commands executed, their results, and any checks that could not be completed.

A successful build does not prove that all features work correctly.

## RULE 6: CREATE A FEATURE DEPENDENCY MAP

For each major feature, identify:

* Its entry point.
* The modules and services it depends on.
* The data it reads and writes.
* Its API endpoints.
* The features that depend on it.
* Its tests and verification status.

Create a dependency map showing how the major modules interact. Identify circular dependencies, tight coupling, and potential points of failure.

## RULE 7: CLASSIFY FINDINGS BY SEVERITY

Use the following categories:

CRITICAL — Data loss, serious security exposure, or a major system failure.
HIGH — Core functionality is broken, important workflows fail, or data integrity is at risk.
MEDIUM — Features are inconsistent, duplicated, or partially broken, with a workaround available.
LOW — Maintainability issues, obsolete code, minor inconsistencies, or nonessential duplication.
UNVERIFIED — A possible issue for which the available evidence is insufficient.

Assign severity based on actual impact, not merely code style or personal preference.

## REQUIRED OUTPUT

Produce an audit report containing:

1. EXECUTIVE SUMMARY
   Overall integration health and the most important findings.

2. VERIFIED SYSTEM MAP
   The actual architecture and major feature dependencies.

3. FEATURE INTEGRATION MATRIX
   For each feature, identify its frontend, backend, data dependencies, connected modules, and verification status.

4. DUPLICATION AND OVERLAP REPORT
   Identify suspected or confirmed duplicates, with evidence and explanations.

5. BROKEN CONNECTIONS REPORT
   Identify incorrect API contracts, unresolved dependencies, mismatched data models, missing integrations, and broken workflows.

6. DATA CONSISTENCY REPORT
   Identify conflicting sources of truth, schema mismatches, validation inconsistencies, and possible data integrity issues.

7. TEST RESULTS
   List commands executed, passed checks, failed checks, skipped checks, and environmental limitations.

8. RISK REGISTER
   List findings by severity, their potential impact, supporting evidence, and affected files.

9. RECOMMENDED FIX PLAN
   Propose the smallest safe changes, ordered by priority. Do not implement them.

10. AUDIT LIMITATIONS
    State which areas remain unverified and what evidence is needed to verify them.

For each finding, provide the actual file paths and relevant function, class, endpoint, model, or test names. Include line numbers where available.

Use these labels:

* VERIFIED: Supported by direct code inspection or an executed test.
* INFERRED: A plausible conclusion based on code structure, but not directly demonstrated.
* UNVERIFIED: Evidence is insufficient.
* TEST FAILED: An executed check or test failed, with the observed result documented.

Do not invent test results, endpoints, files, features, or architectural details.

## FINAL INSTRUCTION

Your goal is to determine whether the existing system works as one coherent application, not merely whether its individual files look correct.

Inspect first, trace dependencies, verify behavior, document evidence, and recommend fixes.

Do not modify the codebase until I have reviewed the audit report and explicitly authorized the changes.

