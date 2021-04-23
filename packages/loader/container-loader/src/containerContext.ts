/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ITelemetryLogger } from "@fluidframework/common-definitions";
import {
    IFluidObject,
    IFluidConfiguration,
    IRequest,
    IResponse,
    IFluidCodeDetails,
    IFluidCodeDetailsComparer,
} from "@fluidframework/core-interfaces";
import {
    IAudience,
    ICodeLoader,
    IContainerContext,
    IDeltaManager,
    ILoader,
    IRuntime,
    ICriticalContainerError,
    ContainerWarning,
    AttachState,
    IFluidModule,
    ILoaderOptions,
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import {
    IClientConfiguration,
    IClientDetails,
    IDocumentAttributes,
    IDocumentMessage,
    IQuorum,
    ISequencedDocumentMessage,
    ISignalMessage,
    ISnapshotTree,
    ITree,
    MessageType,
    ISummaryTree,
    IVersion,
} from "@fluidframework/protocol-definitions";
import { PerformanceEvent } from "@fluidframework/telemetry-utils";
import { assert, LazyPromise } from "@fluidframework/common-utils";
import { Container } from "./container";

const PackageNotFactoryError = "Code package does not implement IRuntimeFactory";

export class ContainerContext implements IContainerContext {
    public static async createOrLoad(
        container: Container,
        scope: IFluidObject,
        codeLoader: ICodeLoader | undefined,
        codeDetails: IFluidCodeDetails,
        runtimeFactory: IRuntimeFactory | undefined,
        baseSnapshot: ISnapshotTree | undefined,
        attributes: IDocumentAttributes,
        deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
        quorum: IQuorum,
        loader: ILoader,
        raiseContainerWarning: (warning: ContainerWarning) => void,
        submitFn: (type: MessageType, contents: any, batch: boolean, appData: any) => number,
        submitSignalFn: (contents: any) => void,
        closeFn: (error?: ICriticalContainerError) => void,
        version: string,
        updateDirtyContainerState: (dirty: boolean) => void,
        pendingLocalState?: unknown,
    ): Promise<ContainerContext> {
        if ((codeLoader === undefined) === (runtimeFactory === undefined)) {
            throw new Error("code loader xor runtime factory is required");
        }

        const context = new ContainerContext(
            container,
            scope,
            codeLoader,
            codeDetails,
            runtimeFactory,
            baseSnapshot,
            attributes,
            deltaManager,
            quorum,
            loader,
            raiseContainerWarning,
            submitFn,
            submitSignalFn,
            closeFn,
            version,
            updateDirtyContainerState,
            pendingLocalState);
        await context.load();
        return context;
    }

    public readonly logger: ITelemetryLogger;

    public get id(): string {
        return this.container.id;
    }

    public get clientId(): string | undefined {
        return this.container.clientId;
    }

    public get clientDetails(): IClientDetails {
        return this.container.clientDetails;
    }

    public get existing(): boolean | undefined {
        return this.container.existing;
    }

    public get branch(): string {
        return this.attributes.branch;
    }

    public get connected(): boolean {
        return this.container.connected;
    }

    public get canSummarize(): boolean {
        return "summarize" in this.runtime;
    }

    public get serviceConfiguration(): IClientConfiguration | undefined {
        return this.container.serviceConfiguration;
    }

    public get audience(): IAudience {
        return this.container.audience;
    }

    public get options(): ILoaderOptions {
        return this.container.options;
    }

    public get configuration(): IFluidConfiguration {
        const config: Partial<IFluidConfiguration> = {
            scopes: this.container.scopes,
        };
        return config as IFluidConfiguration;
    }

    public get baseSnapshot() {
        return this._baseSnapshot;
    }

    public get storage(): IDocumentStorageService | undefined {
        return this.container.storage;
    }

    private _runtime: IRuntime | undefined;
    private get runtime() {
        if (this._runtime === undefined) {
            throw new Error("Attempted to access runtime before it was defined");
        }
        return this._runtime;
    }

    private _disposed = false;

    public get disposed() {
        return this._disposed;
    }

    private readonly fluidExportP: Promise<IFluidModule["fluidExport"]>;

    constructor(
        private readonly container: Container,
        public readonly scope: IFluidObject,
        private readonly codeLoader: ICodeLoader | undefined,
        public readonly codeDetails: IFluidCodeDetails,
        /**
         * Code loader (& details) may be used to load the runtime, or an IRuntimeFactory
         * can be provided directly.  Only one should be provided, but the runtime factory
         * will take precedent if both are present.
         */
        runtimeFactory: IRuntimeFactory | undefined,
        private readonly _baseSnapshot: ISnapshotTree | undefined,
        private readonly attributes: IDocumentAttributes,
        public readonly deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
        public readonly quorum: IQuorum,
        public readonly loader: ILoader,
        public readonly raiseContainerWarning: (warning: ContainerWarning) => void,
        public readonly submitFn: (type: MessageType, contents: any, batch: boolean, appData: any) => number,
        public readonly submitSignalFn: (contents: any) => void,
        public readonly closeFn: (error?: ICriticalContainerError) => void,
        public readonly version: string,
        public readonly updateDirtyContainerState: (dirty: boolean) => void,
        public readonly pendingLocalState?: unknown,
    ) {
        this.fluidExportP = runtimeFactory
            ? Promise.resolve(runtimeFactory)
            : new LazyPromise(async () => {
                if (codeLoader === undefined) {
                    throw new Error("no code provided");
                }

                const fluidModule = await PerformanceEvent.timedExecAsync(this.logger, { eventName: "CodeLoad" },
                    async () => codeLoader.load(codeDetails),
                );

                return fluidModule.fluidExport;
            });

        this.logger = container.subLogger;
        this.attachListener();
    }

    private attachListener() {
        this.container.once("attaching", () => {
            this._runtime?.setAttachState?.(AttachState.Attaching);
        });
        this.container.once("attached", () => {
            this._runtime?.setAttachState?.(AttachState.Attached);
        });
    }

    public dispose(error?: Error): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;

        this.runtime.dispose(error);
        this.quorum.dispose();
        this.deltaManager.dispose();
    }

    public async snapshot(tagMessage: string = "", fullTree: boolean = false): Promise<ITree | null> {
        return this.runtime.snapshot(tagMessage, fullTree);
    }

    public getLoadedFromVersion(): IVersion | undefined {
        return this.container.loadedFromVersion;
    }

    public get attachState(): AttachState {
        return this.container.attachState;
    }

    public createSummary(): ISummaryTree {
        return this.runtime.createSummary();
    }

    public setConnectionState(connected: boolean, clientId?: string) {
        const runtime = this.runtime;

        assert(connected === this.connected, 0x0de /* "Mismatch in connection state while setting" */);

        runtime.setConnectionState(connected, clientId);
    }

    public process(message: ISequencedDocumentMessage, local: boolean, context: any) {
        this.runtime.process(message, local, context);
    }

    public processSignal(message: ISignalMessage, local: boolean) {
        this.runtime.processSignal(message, local);
    }

    public async request(path: IRequest): Promise<IResponse> {
        return this.runtime.request(path);
    }

    public async getAbsoluteUrl(relativeUrl: string): Promise<string | undefined> {
        return this.container.getAbsoluteUrl(relativeUrl);
    }

    public getPendingLocalState(): unknown {
        return this.runtime.getPendingLocalState();
    }

    /**
     * Determines if the current code details of the context
     * satisfy the incoming constraint code details
     */
    public async satisfies(constraintCodeDetails: IFluidCodeDetails) {
        const comparers: IFluidCodeDetailsComparer[] = [];

        const maybeCompareCodeLoader = this.codeLoader;
        if (maybeCompareCodeLoader?.IFluidCodeDetailsComparer !== undefined) {
            comparers.push(maybeCompareCodeLoader.IFluidCodeDetailsComparer);
        }

        const maybeCompareExport = await this.fluidExportP;
        if (maybeCompareExport.IFluidCodeDetailsComparer !== undefined) {
            comparers.push(maybeCompareExport.IFluidCodeDetailsComparer);
        }

        // if there are not comparers it is not possible to know
        // if the current satisfy the incoming, so return false,
        // as assuming they do not satisfy is safer .e.g we will
        // reload, rather than potentially running with
        // incompatible code
        if (comparers.length === 0) {
            return false;
        }

        for (const comparer of comparers) {
            const satisfies = await comparer.satisfies(this.codeDetails, constraintCodeDetails);
            if (satisfies === false) {
                return false;
            }
        }
        return true;
    }

    private async load() {
        const maybeFactory = (await this.fluidExportP).IRuntimeFactory;
        if (maybeFactory === undefined) {
            throw new Error(PackageNotFactoryError);
        }
        this._runtime = await maybeFactory.instantiateRuntime(this);
    }
}
