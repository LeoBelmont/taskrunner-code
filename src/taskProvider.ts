import * as vscode from 'vscode';
import * as fs from 'fs';
import * as JSON5 from 'json5';

export class WorkspaceTreeItem extends vscode.TreeItem {
    children: TreeTask[] = [];

    constructor (label: string) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
    }
}

export class TaskTreeDataProvider implements
vscode.TreeDataProvider<TreeTask | WorkspaceTreeItem> {
    private readonly _context: vscode.ExtensionContext;
    private readonly _onDidChangeTreeData: vscode.EventEmitter<TreeTask | null>
    = new vscode.EventEmitter<TreeTask | null>();

    readonly onDidChangeTreeData: vscode.Event<TreeTask | null>
    = this._onDidChangeTreeData.event;

    private readonly autoRefresh: boolean = true;
    private _unhide: boolean = false;
    private readonly _statusBarI = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left, 0
    );

    private _statusBarBuffer: string[] = [];

    private _registeredType: vscode.Disposable | null = null;

    constructor (private readonly context: vscode.ExtensionContext) {
        this._context = context;
        const autoRefreshConfig: boolean | undefined = vscode.workspace
            .getConfiguration('taskOutlinePlus').get('autorefresh');

        if (autoRefreshConfig === undefined) {
            // default is true
            this.autoRefresh = true;
        } else {
            this.autoRefresh = autoRefreshConfig;
        }
    }

    refresh (): void {
        this._onDidChangeTreeData.fire(null);
    }

    unhide (): void {
        this._unhide = !this._unhide;
        this._onDidChangeTreeData.fire(null);
    }

    public async putTaskCmd (): Promise<void> {
        // set the focus on the statusbar
        this._statusBarI.text = "/";
        this._statusBarI.show();
        this._statusBarBuffer.push("/");

        await vscode
            .commands.executeCommand(
                "setContext",
                "inCmdlineMode",
                true
            );

        this._registeredType = vscode.commands.registerCommand(
            "type", async e => {
                console.log(e);

                if (e.text !== "\n") {
                    this._statusBarBuffer.push(e.text);
                    this._statusBarI.text = this._statusBarBuffer.join("");
                } else {
                    // execute it
                    const tasks = await vscode.tasks.fetchTasks();
                    this._statusBarBuffer.shift();
                    const _task = tasks.filter(
                        t => t.name === this._statusBarBuffer.join("")
                    );

                    if (_task.length > 0) {
                        void vscode.tasks.executeTask(_task[0]);
                        await this.exitTaskCmd();
                    } else {
                        await this.exitTaskCmd();
                        this._statusBarI.text = "-- UNDEFINED TASK --";
                    }
                }
            });
    }

    public async exitTaskCmd (): Promise<void> {
        this._registeredType?.dispose();
        await vscode
            .commands.executeCommand(
                "setContext",
                "inCmdlineMode",
                false
            );
        this._statusBarBuffer = [];
        this._statusBarI.text = "";
    }

    public async backTaskCmd (): Promise<void> {
        if (this._statusBarBuffer.length > 1) {
            this._statusBarBuffer.pop();
            this._statusBarI.text = this._statusBarBuffer.join("");
        }
    }

    public async tabTaskCmd (): Promise<void> {
        const tasks_ = await vscode.tasks.fetchTasks();
        const tasks = tasks_.filter(t => t.source === "Workspace");
        const _part = this._statusBarBuffer.join("").replace("/", "");

        // algoritm to get the most close match
        let _match: string | null = null;
        const _matches: string[] = [];
        let _matchCount: number = 0;
        for (const _task of tasks) {
            if (_task.name.startsWith(_part)) {
                if (_match == null) {
                    _match = _task.name;
                    _matchCount++;
                } else {
                    _matchCount++;
                }

                // in multi-root workspaces we need to label the tasks by folder
                if (
                    vscode.workspace.workspaceFolders != null &&
                    vscode.workspace.workspaceFolders.length > 1
                ) {
                    let _workSpaceName = "";
                    if (typeof _task.scope !== "string") {
                        _workSpaceName =
                            (_task.scope as vscode.WorkspaceFolder).name;
                    }

                    _matches.push(`${_task.name} (${_workSpaceName})`);
                } else {
                    _matches.push(`${_task.name}`);
                }
            }
        }

        if (_match != null && _matchCount === 1) {
            this._statusBarBuffer = ["/", ..._match.split("")];
            this._statusBarI.text = this._statusBarBuffer.join("");
        } else if (_matchCount >= 2) {
            // we will show the list, make sure to have the backspace back
            await vscode
                .commands.executeCommand(
                    "setContext",
                    "inCmdlineMode",
                    false
                );

            // show option list
            let _pick = await vscode.window.showQuickPick(_matches);
            if (_pick != null) {
                let _name = "";
                if (_pick.includes("(") && _pick.includes(")")) {
                    // eslint-disable-next-line max-len
                    // we get the match for the task name and the (workspace name)
                    const _rawTask = _pick.split(" ")[0];
                    _name =
                        _pick.split(" ")[1].replace("(", "").replace(")", "");
                    _pick = _rawTask;
                } else {
                    _name = _pick;
                }

                this._statusBarBuffer = ["/", ..._pick.split("")];
                this._statusBarI.text = this._statusBarBuffer.join("");

                // execute it
                const tasks = await vscode.tasks.fetchTasks();
                this._statusBarBuffer.shift();

                let _task: vscode.Task[] = [];
                if (
                    vscode.workspace.workspaceFolders != null &&
                    vscode.workspace.workspaceFolders.length > 1
                ) {
                    _task = tasks.filter(
                        t =>
                            t.name === this._statusBarBuffer.join("") &&
                            (t.scope as vscode.WorkspaceFolder).name === _name
                    );
                } else {
                    _task = tasks.filter(
                        t =>
                            t.name === this._statusBarBuffer.join("")
                    );
                }

                if (_task.length > 0) {
                    void vscode.tasks.executeTask(_task[0]);
                    await this.exitTaskCmd();
                } else {
                    await this.exitTaskCmd();
                    this._statusBarI.text = "-- UNDEFINED TASK --";
                }
            }
        }
    }

    public async getChildren (task?: TreeTask | WorkspaceTreeItem):
    Promise<Array<TreeTask | WorkspaceTreeItem>> {
        if (task instanceof WorkspaceTreeItem) {
            // If this is a workspace item, return only its children
            return task.children;
        }

        // Otherwise, return the top-level list
        let tasks: vscode.Task[] = await vscode.tasks.fetchTasks();
        tasks = tasks.filter(t => t.source === "Workspace");

        const taskElements: Array<WorkspaceTreeItem | TreeTask> = [];
        const taskFolders: { [key: string]: WorkspaceTreeItem } = {};

        for (const task of tasks) {
            const _task = new TreeTask(
                task.definition.type,
                task.name,
                vscode.TreeItemCollapsibleState.None,
                {
                    command: 'taskOutlinePlus.executeTask',
                    title: "Execute",
                    arguments: [task, task.scope]
                },
                task.scope
            );

            if (task.detail != null) {
                _task.tooltip = task.detail;
            }

            if (!_task.hide || this._unhide) {
                if (_task.workspace !== null) {
                    if (taskFolders[_task.workspace] === undefined) {
                        const ws = new WorkspaceTreeItem(_task.workspace);
                        taskFolders[_task.workspace] = ws;
                        taskElements.push(ws);
                    }
                    taskFolders[_task.workspace].children.push(_task);
                } else {
                    taskElements.push(_task);
                }
            }
        }

        // Sort logic (workspace folders first, then label)
        taskElements.sort((a, b) => {
            const aIsWorkspace = a instanceof WorkspaceTreeItem;
            const bIsWorkspace = b instanceof WorkspaceTreeItem;

            if (aIsWorkspace && !bIsWorkspace) return -1;
            if (!aIsWorkspace && bIsWorkspace) return 1;

            const aLabel = typeof a.label === "string"
                ? a.label : a.label?.label ?? "";
            const bLabel = typeof b.label === "string"
                ? b.label : b.label?.label ?? "";

            return aLabel.localeCompare(bLabel);
        });

        return taskElements;
    }

    getTreeItem (task: TreeTask | WorkspaceTreeItem): vscode.TreeItem {
        return task;
    }
}

export class TreeTask extends vscode.TreeItem {
    type: string;
    hide: boolean = false;
    workspace: string | null = null;

    constructor (
        type: string,
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        command?: vscode.Command,
        workspace?: vscode.WorkspaceFolder | vscode.TaskScope
    ) {
        super(label, collapsibleState);
        this.type = type;
        this.command = command;
        this.label = `${this.label as string}`;
        if (typeof workspace === 'object' && workspace !== null) {
            // Multi-root: WorkspaceFolder
            this.workspace = workspace.name;
        } else {
            // No scope, root or unknown
            this.workspace = null;
        }

        const multiRoot = vscode.workspace.workspaceFolders!.length > 1;

        for (const _workspace of vscode.workspace.workspaceFolders!) {
            let _tasksJson;
            // Make sure that the task is not hidden by reading the workspace
            // tasks.json file. Also, on a multiroot workspace the tasks may
            // be defined just on the code-workspace file and there may not
            // be a .vscode/tasks.json file
            if (
                multiRoot &&
                // eslint-disable-next-line max-len
                fs.existsSync(`${_workspace.uri.fsPath}/${_workspace.name}.code-workspace`)
            ) {
                _tasksJson = JSON5.parse(
                    fs.readFileSync(
                        // eslint-disable-next-line max-len
                        `${_workspace.uri.fsPath}/${_workspace.name}.code-workspace`, 'utf8'
                    )
                ).tasks;
                // If it exists, concatenate the tasks from both places
                if (fs.existsSync(
                    `${_workspace.uri.fsPath}/.vscode/tasks.json`)) {
                    const _tasksJsonFile = JSON5.parse(
                        fs.readFileSync(
                            // eslint-disable-next-line max-len
                            `${_workspace.uri.fsPath}/.vscode/tasks.json`, 'utf8'
                        )
                    );
                    _tasksJson.tasks = [
                        ..._tasksJson.tasks,
                        ..._tasksJsonFile.tasks
                    ]
                }
            } else {
                _tasksJson = JSON5.parse(
                    fs.readFileSync(
                        `${_workspace.uri.fsPath}/.vscode/tasks.json`, 'utf8'
                    )
                );
            }

            for (const _task of _tasksJson.tasks) {
                if (_task.label === this.label) {
                    this.hide = _task.hide ?? false;

                    // icon
                    if (_task.icon != null && _task.icon.id !== "") {
                        this.iconPath = new vscode.ThemeIcon(
                            _task.icon.id,
                            _task.icon.color
                        );
                    }

                    break;
                }
            }
        }
    }
}
