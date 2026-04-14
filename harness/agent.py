"""
harness/agent.py
EvoHarness RPC Router 优化代理
"""

import subprocess
import json
import os
from pathlib import Path
from typing import Any, Dict

class RouterHarness:
    """EvoHarness RPC Router Harness - 被 proposer 调用来评估新策略"""
    
    def __init__(self, repo_root: str = None):
        """初始化 harness"""
        self.repo_root = repo_root or Path(__file__).parent.parent
        self.router_path = Path(self.repo_root) / "harness" / "router.mjs"
        self.helius_key = os.environ.get("HELIUS_API_KEY", "")
        
    def evaluate_config(self, wallet_address: str, wallet_type: str, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        评估某个配置下的路由性能
        
        Args:
            wallet_address: Solana 钱包地址
            wallet_type: 钱包类型 (sparse/medium/dense/whale/periodic/mega)
            config: 配置参数 (periodicChunking, megaHierarchical, bandLogic 等)
        
        Returns:
            {
                "latency": 0.5,
                "tx_count": 100,
                "surfaces": {...},
                "score": 8.5
            }
        """
        # 注入配置到环境变量（EvoHarness 会设置这些）
        env = os.environ.copy()
        env["HELIUS_API_KEY"] = self.helius_key
        env["ROUTER_CONFIG"] = json.dumps(config)
        
        try:
            # 调用 Bun 脚本
            result = subprocess.run(
                ["bun", str(self.router_path), wallet_address, wallet_type],
                capture_output=True,
                text=True,
                env=env,
                timeout=120,
                check=True
            )
            
            # 解析输出
            output = result.stdout.strip()
            lines = output.split('\n')
            
            # 最后一行应该是 JSON 结果
            json_str = lines[-1]
            metric = json.loads(json_str)
            
            # 计算综合评分 (EvoHarness 会用这个来排序变体)
            # 评分 = 10 / (1 + latency_seconds)
            # 例如: 0.5s 延迟 -> 6.67 分
            #      1.0s 延迟 -> 5.0 分
            #      2.0s 延迟 -> 3.33 分
            latency = metric.get("latency", 1.0)
            score = 10.0 / (1.0 + latency)
            
            return {
                "latency": latency,
                "tx_count": metric.get("txCount", 0),
                "surfaces": metric.get("surfaces", config),
                "score": round(score, 2),
                "address": metric.get("address"),
                "status": "success"
            }
            
        except subprocess.TimeoutExpired:
            return {
                "status": "timeout",
                "timeout_seconds": 120,
                "score": 0.0
            }
        except subprocess.CalledProcessError as e:
            return {
                "status": "error",
                "error": e.stderr,
                "score": 0.0
            }
        except json.JSONDecodeError as e:
            return {
                "status": "parse_error",
                "error": str(e),
                "output": output,
                "score": 0.0
            }
    
    def get_surfaces_config(self) -> Dict[str, Any]:
        """返回所有可调参数（surfaces）的当前配置"""
        return {
            "periodicChunking": {
                "type": "int",
                "min": 4,
                "max": 24,
                "default": 12,
                "description": "Periodic wallet 时间分片数量（越小越快但精度低，越大越精确但调用多）"
            },
            "megaRecursionDepth": {
                "type": "int",
                "min": 1,
                "max": 5,
                "default": 3,
                "description": "Mega wallet 递归深度（控制分层查询的细度）"
            },
            "bandLogic": {
                "type": "choice",
                "choices": ["dynamic", "fixed", "adaptive"],
                "default": "dynamic",
                "description": "Band 选择逻辑（dynamic: 基于 tx 量自适应，fixed: 固定 8 块，adaptive: 学习最优）"
            },
            "cacheStrategy": {
                "type": "choice",
                "choices": ["none", "l0", "l0-l1"],
                "default": "l0",
                "description": "缓存策略（none: 无缓存，l0: 简单缓存，l0-l1: 多层缓存）"
            },
            "maxConcurrent": {
                "type": "int",
                "min": 1,
                "max": 32,
                "default": 8,
                "description": "RPC 并发调用数（越高越快但可能触发 rate limit）"
            }
        }


# stdout 调用示例（EvoHarness 会这样调用）：
if __name__ == "__main__":
    import sys
    
    harness = RouterHarness()
    
    # 示例：评估某个配置
    if len(sys.argv) > 1:
        wallet_addr = sys.argv[1]  # 第一个参数：钱包地址
        wallet_type = sys.argv[2] if len(sys.argv) > 2 else "default"  # 第二个参数：钱包类型
        
        # 读取配置（从 ROUTER_CONFIG 环境变量）
        config_str = os.environ.get("ROUTER_CONFIG", "{}")
        config = json.loads(config_str)
        
        # 评估
        result = harness.evaluate_config(wallet_addr, wallet_type, config)
        print(json.dumps(result, indent=2))
    else:
        # 打印 surfaces 配置
        print("Available surfaces:")
        for name, spec in harness.get_surfaces_config().items():
            print(f"  {name}: {spec}")
