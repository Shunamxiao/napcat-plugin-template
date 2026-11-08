import { resolve, dirname } from 'path';
import { defineConfig } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { execSync } from 'child_process';
import { napcatHmrPlugin } from 'napcat-plugin-debug-cli/vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

const nodeModules = [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
].flat();

// 依赖排除（如有外部依赖需排除，在此添加）
const external: string[] = [];

// 构建戳：commit + 构建时间。部署后 /plugin/<id>/api/status 的 data.build 必须等于本地 git HEAD——
// 用来一眼判断设备上跑的是不是最新代码（2026-11-08 前产物无版本，只能靠 md5 猜，页面旧了无人知）。
const BUILD_ID = (() => {
    let sha = 'nogit';
    let dirty = '';
    try {
        sha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
        // 工作区脏时加 -dirty：否则「设备 build == HEAD」会掩盖未提交改动也被发上去的事实
        if (execSync('git status --porcelain', { cwd: __dirname }).toString().trim()) dirty = '-dirty';
    } catch { /* 非 git 环境 */ }
    const t = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${sha}${dirty}-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`;
})();

/**
 * 递归复制目录
 */
function copyDirRecursive(src: string, dest: string) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = resolve(src, entry.name);
        const destPath = resolve(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * 构建后自动复制资源的 Vite 插件
 * - 复制 webui 构建产物到 dist/webui
 * - 生成精简的 package.json（只保留运行时必要字段）
 * - 复制 templates 目录（如果存在）
 */
function copyAssetsPlugin() {
    return {
        name: 'copy-assets',
        writeBundle() {
            try {
                const distDir = resolve(__dirname, 'dist');

                // 1. 构建 WebUI 前端
                const webuiRoot = resolve(__dirname, 'src/webui');
                try {
                    // 先确保 webui 子项目的依赖已安装
                    if (!fs.existsSync(resolve(webuiRoot, 'node_modules'))) {
                        console.log('[copy-assets] (o\'v\'o) 正在安装 WebUI 依赖...');
                        execSync('pnpm install', {
                            cwd: webuiRoot,
                            stdio: 'pipe',
                        });
                        console.log('[copy-assets] (o\'v\'o) WebUI 依赖安装完成');
                    }

                    console.log('[copy-assets] (o\'v\'o) 正在构建 WebUI...');
                    const webuiEnv = { ...process.env };
                    delete webuiEnv.NODE_ENV;
                    execSync('pnpm run build', {
                        cwd: webuiRoot,
                        stdio: 'pipe',
                        env: webuiEnv,
                    });
                    console.log('[copy-assets] (o\'v\'o) WebUI 构建完成');
                } catch (e: any) {
                    // 构建失败必须让整次构建失败：旧的只 console.error 继续跑，会留下「服务端新、页面旧」的半截 dist
                    throw new Error('[copy-assets] WebUI 构建失败: ' + (e.stdout?.toString().slice(-300) || e.message));
                }

                // 2. 复制 webui 构建产物
                const webuiDist = resolve(__dirname, 'src/webui/dist');
                const webuiDest = resolve(distDir, 'webui');
                if (fs.existsSync(webuiDist)) {
                    copyDirRecursive(webuiDist, webuiDest);
                    console.log('[copy-assets] (o\'v\'o) 已复制 webui 构建产物');
                } else {
                    console.error('[copy-assets] (;_;) webui 构建产物不存在，请先运行 pnpm run build:webui');
                }

                // 3. 生成精简的 package.json（只保留运行时必要字段）
                const pkgPath = resolve(__dirname, 'package.json');
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                    const distPkg: Record<string, unknown> = {
                        name: pkg.name,
                        plugin: pkg.plugin,
                        version: pkg.version,
                        type: pkg.type,
                        main: pkg.main,
                        description: pkg.description,
                        author: pkg.author,
                        dependencies: pkg.dependencies,
                    };
                    if (pkg.napcat) {
                        distPkg.napcat = pkg.napcat;
                    }
                    fs.writeFileSync(
                        resolve(distDir, 'package.json'),
                        JSON.stringify(distPkg, null, 2)
                    );
                    console.log('[copy-assets] (o\'v\'o) 已生成精简 package.json');
                }

                // 4. 复制 templates 目录（如果存在）
                const templatesSrc = resolve(__dirname, 'templates');
                if (fs.existsSync(templatesSrc)) {
                    copyDirRecursive(templatesSrc, resolve(distDir, 'templates'));
                    console.log('[copy-assets] (o\'v\'o) 已复制 templates 目录');
                }

                console.log('[copy-assets] (*\'v\'*) 资源复制完成！');
            } catch (error) {
                console.error('[copy-assets] (;_;) 资源复制失败:', error);
            }
        },
    };
}

export default defineConfig({
    resolve: {
        conditions: ['node', 'default'],
    },
    build: {
        sourcemap: false,
        target: 'esnext',
        minify: false,
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: () => 'index.mjs',
        },
        rollupOptions: {
            external: [...nodeModules, ...external],
            output: {
                inlineDynamicImports: true,
            },
        },
        outDir: 'dist',
    },
    plugins: [nodeResolve(), copyAssetsPlugin(), napcatHmrPlugin({
        webui: {
            distDir: './src/webui/dist',
            targetDir: 'webui',
        },
    })],
    define: {
        __BUILD_ID__: JSON.stringify(BUILD_ID),
    },
});
