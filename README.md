# Ongyeol teacher training app

## Local setup

1. Install packages with `npm install`.
2. Create the first administrator with `npm run admin:create`. Enter the administrator email, name, department, and password. The password prompt is hidden in a terminal.
3. Start the web app with `npm start` and open port 3000.
4. Teachers submit an account request. An administrator approves accounts from the administrator page.

The SQLite database and uploaded files are stored outside the public web folder in `~/.ongyeol-data` by default. Set `DATA_DIR` to a protected, persistent server directory before running the app if you need a different location. Back up the whole directory regularly. Do not expose that directory through a web server.

The initial administrator command must be run on the same server and use the same `DATA_DIR` as the app. For a hosted deployment, mount persistent storage and run the setup command once before inviting teachers. This project does not configure an external email service; login uses email and password, and new accounts wait for administrator approval.

The administrator screen is available at `/admin` after administrator login. Teachers only receive their own records from the server API; administrator-only API routes check the account role on the server. The initial school is 주엽고등학교; the department and teacher roster and required training list can be maintained in administrator settings.
