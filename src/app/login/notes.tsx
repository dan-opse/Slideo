// The error or confirmation a sign-in form redirected back with.
export function LoginNotes({
  error,
  message,
}: {
  error?: string;
  message?: string;
}) {
  return (
    <>
      {error && (
        <p className="login-note error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="login-note" role="status">
          {message}
        </p>
      )}
    </>
  );
}
