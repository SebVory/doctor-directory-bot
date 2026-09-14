import { describe, expect, it } from "vitest";
import { type CandidateAttributes, bestQuestion } from "../src/doctor-store.js";

function candidate(over: Partial<CandidateAttributes> = {}): CandidateAttributes {
  return {
    last_name: "Novák",
    location: "Praha",
    speciality: "Cardiology",
    first_name: "Jan",
    languages: ["Czech"],
    ...over,
  };
}

describe("bestQuestion", () => {
  it("asks about the surname first when the net caught more than one", () => {
    // Wide net: Dumitrescu at 0.85+ and Dumitru at 0.7 both survive. The first
    // question must be which surname, not which city.
    const candidates = [
      ...Array.from({ length: 8 }, (_, i) =>
        candidate({ last_name: "Dumitrescu", location: `Mesto${i}` }),
      ),
      ...Array.from({ length: 6 }, (_, i) => candidate({ last_name: "Dumitru", location: `Mesto${i}` })),
    ];

    const question = bestQuestion(candidates);
    expect(question?.attribute).toBe("last_name");
    expect(question?.options).toEqual([
      { value: "Dumitrescu", count: 8 },
      { value: "Dumitru", count: 6 },
    ]);
    expect(question?.distinct_total).toBe(2);
  });

  it("reports how many values exist when options only shows four", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate({ location: `Mesto${i}` }));
    const question = bestQuestion(candidates);
    expect(question?.options).toHaveLength(4);
    expect(question?.distinct_total).toBe(10);
  });

  it("asks about speciality, not city, when the city barely splits the field", () => {
    // 50 Nováks: 45 in Praha and 5 in Brno, spread evenly over 5 specialities.
    const specialities = ["Cardiology", "Neurology", "Pediatrics", "Urology", "Oncology"];
    const candidates = Array.from({ length: 50 }, (_, i) =>
      candidate({
        location: i < 45 ? "Praha" : "Brno",
        speciality: specialities[i % specialities.length] ?? "Cardiology",
      }),
    );

    const question = bestQuestion(candidates);
    // city's worst bucket is 45; speciality's is 10.
    expect(question?.attribute).toBe("speciality");
    expect(question?.options).toHaveLength(4); // top 4 of 5
    expect(question?.options.every((o) => o.count === 10)).toBe(true);
  });

  it("never asks which clinic — it is a bijection with the city in this data", () => {
    // 42 clinics, 42 cities, "Clinica {city} Care". Asking the clinic adds nothing
    // over asking the city and uses a word no caller would say.
    const question = bestQuestion([candidate({ location: "Praha" }), candidate({ location: "Brno" })]);
    expect(question?.attribute).toBe("city");
    expect(question?.attribute).not.toBe("clinic_name");
  });

  it("never asks about an attribute every candidate shares", () => {
    const question = bestQuestion([
      candidate({ speciality: "Neurology" }),
      candidate({ speciality: "Urology" }),
    ]);
    expect(question?.attribute).toBe("speciality"); // city/clinic/languages are identical
  });

  it("returns null for a single candidate", () => {
    expect(bestQuestion([candidate()])).toBeNull();
    expect(bestQuestion([])).toBeNull();
  });

  it("returns null when the candidates are indistinguishable", () => {
    expect(bestQuestion([candidate(), candidate()])).toBeNull();
  });

  it("prefers the receptionist's question when professional attributes are shared", () => {
    // The Munteanu case: same city, speciality and clinic; only the given name
    // and the languages differ. Both split perfectly, so order decides.
    const question = bestQuestion([
      candidate({ first_name: "Daria", languages: ["English"] }),
      candidate({ first_name: "Bogdan", languages: ["Hungarian", "German"] }),
    ]);

    expect(question?.attribute).toBe("first_name");
    expect(question?.options).toEqual([
      { value: "Bogdan", count: 1 },
      { value: "Daria", count: 1 },
    ]);
  });

  it("counts a multi-valued attribute per value", () => {
    const question = bestQuestion([
      candidate({ languages: ["Czech", "German"] }),
      candidate({ languages: ["Czech"] }),
    ]);
    expect(question?.attribute).toBe("languages");
    expect(question?.options).toEqual([
      { value: "Czech", count: 2 },
      { value: "German", count: 1 },
    ]);
  });
});
