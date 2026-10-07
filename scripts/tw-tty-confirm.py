#!/usr/bin/env python3
"""Run a command on a pseudo-terminal and answer one confirmation phrase.

stdin and stdout are the terminal, so Node reports them as TTYs. stderr stays
a pipe. After the child writes a line ending in "to confirm:", this writes
PHRASE and a newline to the terminal. Echo is turned off so the phrase is not
mixed into the JSON the command prints on stdout.

MCP stdio and a non-TTY `tw` cannot use this. Local e2e scripts are the operator
for `tw send` and oracle-key `tw escrow settle`.
"""

import os
import pty
import select
import subprocess
import sys
import termios


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: tw-tty-confirm.py PHRASE COMMAND [ARG ...]", file=sys.stderr)
        return 2

    phrase = sys.argv[1]
    command = sys.argv[2:]
    master, slave = pty.openpty()
    attrs = termios.tcgetattr(slave)
    attrs[3] = attrs[3] & ~termios.ECHO
    termios.tcsetattr(slave, termios.TCSANOW, attrs)

    proc = subprocess.Popen(
        command,
        stdin=slave,
        stdout=slave,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    os.close(slave)

    sent = False
    stdout = bytearray()
    stderr = bytearray()

    def send_phrase_if_prompted() -> None:
        nonlocal sent
        if sent or b"to confirm:" not in stderr:
            return
        os.write(master, (phrase + "\n").encode())
        sent = True

    while True:
        if proc.poll() is not None:
            break
        watch = [master]
        if proc.stderr is not None:
            watch.append(proc.stderr)
        readable, _, _ = select.select(watch, [], [], 60)
        if not readable:
            proc.kill()
            print("timed out waiting for terminal confirmation", file=sys.stderr)
            return 1
        for stream in readable:
            if stream == master:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    stdout.extend(chunk)
                continue
            chunk = os.read(proc.stderr.fileno(), 65536)
            if not chunk:
                continue
            stderr.extend(chunk)
            sys.stderr.buffer.write(chunk)
            sys.stderr.buffer.flush()
            send_phrase_if_prompted()

    deadline = 0
    while deadline < 20:
        watch = [master]
        if proc.stderr is not None:
            watch.append(proc.stderr)
        readable, _, _ = select.select(watch, [], [], 0.1)
        if not readable:
            deadline += 1
            continue
        deadline = 0
        for stream in readable:
            if stream == master:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    stdout.extend(chunk)
                continue
            chunk = os.read(proc.stderr.fileno(), 65536)
            if chunk:
                stderr.extend(chunk)
                sys.stderr.buffer.write(chunk)
                sys.stderr.buffer.flush()
                send_phrase_if_prompted()

    status = proc.wait()
    sys.stdout.buffer.write(stdout)
    sys.stdout.buffer.flush()
    try:
        os.close(master)
    except OSError:
        pass
    return status


if __name__ == "__main__":
    sys.exit(main())
