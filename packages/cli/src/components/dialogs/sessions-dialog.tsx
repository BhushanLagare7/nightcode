import { TextAttributes } from "@opentui/core";
import { format } from "date-fns";
import type { InferResponseType } from "hono/client";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { apiClient } from "../../lib/api-client";
import { getErrorMessage } from "../../lib/http-errors";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";

type Session = InferResponseType<typeof apiClient.sessions.$get, 200>[number];

export const SessionDialogContent = () => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  const navigate = useNavigate();
  const { close } = useDialog();
  const { show } = useToast();

  useEffect(() => {
    let ignore = false;

    const fetchSessions = async () => {
      setLoading(true);
      try {
        const response = await apiClient.sessions.$get();

        if (!response.ok) {
          throw new Error(await getErrorMessage(response));
        }

        const data = await response.json();

        if (!ignore) {
          setSessions(data);
          setLoading(false);
        }
      } catch (error) {
        if (!ignore) {
          show({
            message:
              error instanceof Error
                ? error.message
                : "Failed to fetch sessions",
            variant: "error",
          });
          close();
        }
      }
    };

    fetchSessions();

    return () => {
      ignore = true;
    };
  }, [show, close]);

  const handleSelect = useCallback(
    (session: Session) => {
      close();
      navigate(`/sessions/${session.id}`);
    },
    [navigate, close],
  );

  if (loading) {
    return (
      <box flexDirection="column">
        <text attributes={TextAttributes.DIM}>Loading sessions...</text>
      </box>
    );
  }

  return (
    <DialogSearchList
      emptyText="No matching sessions"
      filterFn={(s, q) => s.title.toLowerCase().includes(q.toLowerCase())}
      getKey={(session) => session.id}
      items={sessions}
      placeholder="Search sessions"
      renderItem={(session, isSelected) => (
        <>
          <text fg={isSelected ? "black" : "white"} selectable={false}>
            {session.title}
          </text>
          <box flexGrow={1} />
          <text
            attributes={TextAttributes.DIM}
            fg={isSelected ? "black" : undefined}
            selectable={false}
          >
            {format(new Date(session.createdAt), "hh:mm a")}
          </text>
        </>
      )}
      onSelect={handleSelect}
    />
  );
};
