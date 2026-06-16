---
name: review-plan
user-invocable: true
description: Review and optimize an implementation plan before executing it — checks logical consistency, sequencing, vertical-slice structure, and validation points.
---

Before executing this plan, review and optimize it:

1. **Logical Consistency**: Verify each task's prerequisites are satisfied by prior tasks. Ensure no circular dependencies or gaps in the workflow.

2. **Sequencing**: Confirm tasks are ordered so that:
   - Dependencies flow naturally (no task requires output from a later task)
   - Earlier tasks unblock multiple downstream tasks where possible
   - Critical path items are identified and prioritized

3. **Vertical Slice Optimization**: Restructure tasks to create complete, end-to-end features that:
   - Deliver working functionality (not just scaffolding)
   - Can be tested independently
   - Provide incremental value

4. **Validation Points**: Ensure each task concludes with:
   - All applicable tests passing
   - Linting/type checking passing
   - The feature demonstrably working
   - No broken functionality from previous tasks
   
5. **Project-level guidelines** Check project guidelines and make sure the plan follows them

6. **Plan Purity**: The plan must contain ONLY actionable tasks and implementation details. Remove meta-commentary about the plan itself:
   - NO: Explanations of planning methodology ("This uses vertical slicing...")
   - NO: Rationales for task ordering ("This is simplest so we do it first...")
   - NO: Commentary on task placement ("This validates the approach...")
   - YES: Task purpose/description (what it does, why it's needed technically)
   - YES: Design notes (implementation details, technical decisions)
   - YES: Completion criteria (how to verify task is done)

7. **Adjustments**: If any issues are found, revise the plan and explain changes made.

Present the reviewed/revised plan and wait for approval before executing.
