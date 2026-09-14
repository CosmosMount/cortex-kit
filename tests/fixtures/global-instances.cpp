struct Sample { float value; int count; };
class Motor {
public:
    Sample samples[2];
    static Motor instance;
    static Motor& Instance() {
        static Motor instance = {{{1.5f, 1}, {2.5f, 2}}};
        return instance;
    }
};
Motor Motor::instance = {{{3.5f, 3}, {4.5f, 4}}};
class Sensor {
public:
    Sample samples[2];
    static Sensor& Instance() {
        static Sensor instance = {{{5.5f, 5}, {6.5f, 6}}};
        return instance;
    }
};
namespace robot {
Motor global = {{{7.5f, 7}, {8.5f, 8}}};
Motor* motor_pointer = &Motor::instance;
}
extern "C" int main() {
    asm volatile("" : : "r"(&Motor::Instance()), "r"(&Sensor::Instance()),
        "r"(&Motor::instance), "r"(&robot::global), "r"(&robot::motor_pointer) : "memory");
    return 0;
}
