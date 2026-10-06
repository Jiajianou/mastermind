import type { Task, TaskEdit } from "@mastermind/core/contracts";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useApi, useDispatch } from "../store/hooks.js";
import { emptyTaskForm, parseNewTask, parseTaskEdit, taskFormValues } from "./form.js";
import type { NewTask } from "./form.js";
import { tasksPath } from "./location.js";
import type { TasksView } from "./location.js";
import { TaskDetails } from "./TaskDetails.js";
import { TaskForm } from "./TaskForm.js";

export function NewTaskPanel({ view }: { view: TasksView }) {
  const api = useApi();
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const save = async (input: NewTask) => {
    const created = await api.act("createTasks", { tasks: [input] });
    for (const task of created) dispatch({ type: "task.updated", taskId: task.id, task });
    void navigate(tasksPath({ view, task: input.id }));
  };

  return (
    <TaskForm
      heading="New task"
      initial={emptyTaskForm}
      withId
      submitLabel="Create task"
      busyLabel="Creating…"
      parse={parseNewTask}
      save={save}
      onCancel={() => {
        void navigate(tasksPath({ view }));
      }}
    />
  );
}

export function TaskPanel({ task, tasks }: { task: Task; tasks: readonly Task[] }) {
  const api = useApi();
  const dispatch = useDispatch();
  const [editing, setEditing] = useState<Task | null>(null);

  const save = async (edit: TaskEdit) => {
    if (Object.keys(edit).length > 0) {
      const updated = await api.act("updateTask", { taskId: task.id, ...edit });
      dispatch({ type: "task.updated", taskId: task.id, task: updated });
    }
    setEditing(null);
  };

  if (editing === null)
    return (
      <TaskDetails
        task={task}
        tasks={tasks}
        onEdit={() => {
          setEditing(task);
        }}
      />
    );
  return (
    <TaskForm
      heading={`Edit ${task.id}`}
      initial={taskFormValues(editing)}
      withId={false}
      submitLabel="Save changes"
      busyLabel="Saving…"
      parse={(values) => parseTaskEdit(editing, values)}
      save={save}
      onCancel={() => {
        setEditing(null);
      }}
    />
  );
}
