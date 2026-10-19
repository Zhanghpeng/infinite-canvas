import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";

import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { resolveStorageBackend } from "@/lib/storage/bootstrap";

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

// 必须先把存储模式解析好（本地模式会切换后端），再导入应用模块。
// 应用里的 zustand store 在模块导入时就会按当前后端 rehydrate，顺序反了会读错存储。
async function bootstrap() {
    await resolveStorageBackend();
    const [{ RouterProvider }, { AppProviders }, { router }] = await Promise.all([import("react-router-dom"), import("@/components/layout/app-providers"), import("@/router")]);

    initAnalytics();

    createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
            </AppProviders>
        </React.StrictMode>,
    );
}

void bootstrap();
