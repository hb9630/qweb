// ctx 窗口记忆 —— 对照 server.mjs:58-79
// transcript 不写 result 行，历史回放的合成 result 没有 modelUsage 时，
// 用这里落盘的 contextWindow 兜底（裸名键），分母不依赖浏览器 localStorage。
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

pub struct CtxWin {
    path: String,
    mem: Mutex<Option<HashMap<String, u64>>>, // 启动懒加载；运行中合并写回
}

/// 剥离大小写不敏感的 [1m] 后缀（glm-5.3[1m] → glm-5.3）
fn normalize(model: &str) -> String {
    if model.len() >= 4 && model[..model.len() - 3].len() >= 1 {
        let lower = model.to_lowercase();
        if let Some(stem) = lower.strip_suffix("[1m]") {
            return model[..stem.len()].to_string();
        }
    }
    model.to_string()
}

impl CtxWin {
    pub fn new(path: String) -> Self {
        Self { path, mem: Mutex::new(None) }
    }

    fn load(&self) {
        let mut g = self.mem.lock().unwrap();
        if g.is_none() {
            *g = std::fs::read_to_string(&self.path)
                .ok()
                .and_then(|s| serde_json::from_str::<HashMap<String, u64>>(&s).ok());
        }
    }

    /// live result.modelUsage 到达时合并落盘（fire-and-forget，失败忽略）
    pub fn remember(&self, mu: Option<&Value>) {
        let Some(obj) = mu.and_then(|v| v.as_object()) else { return };
        let mut dirty = false;
        {
            let mut g = self.mem.lock().unwrap();
            for (k, v) in obj {
                let Some(cw) = v.get("contextWindow").and_then(|x| x.as_u64()) else { continue };
                let key = normalize(k);
                let slot = g.get_or_insert_with(HashMap::new);
                if slot.get(&key).copied() != Some(cw) {
                    slot.insert(key, cw);
                    dirty = true;
                }
            }
        }
        if dirty {
            if let Some(mem) = self.mem.lock().unwrap().as_ref() {
                if let Ok(s) = serde_json::to_string(mem) {
                    let _ = std::fs::write(&self.path, s);
                }
            }
        }
    }

    /// 该模型（裸名）的记忆窗口；无记忆返回 None
    pub fn of(&self, model: &str) -> Option<u64> {
        self.load();
        self.mem.lock().unwrap().as_ref()?.get(&normalize(model)).copied()
    }
}
