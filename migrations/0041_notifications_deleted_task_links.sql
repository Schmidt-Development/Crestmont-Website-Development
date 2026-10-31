-- Notifications about tasks that were later deleted kept linking to /staff/tasks/<id>, which answers 404
-- (staging deploy #57: the BRAND-006 browser check followed such a link from the developer's pages).
-- deleteTask() now unlinks them when it deletes; this repairs rows left before that change. Idempotent; the
-- notification text is kept, only the dead link is removed.
UPDATE notifications SET subject_type = NULL, subject_id = NULL
 WHERE subject_type = 'task' AND subject_id IS NOT NULL AND subject_id NOT IN (SELECT id FROM tasks);
